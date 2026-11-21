// 群組找人後台：HTTP 路由與權限檢查
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { newToken, randomName, safeEqual } from './crypto.js';
import { MIN_CREATE_CODE } from './config.js';
import { createLimiter } from './ratelimit.js';
import { openStore } from './store.js';
import { createPusher } from './push.js';
import { forward, isProxyPath, proxyKind } from './proxy.js';
import {
  HttpError, EMOJIS, cleanName, cleanGroupName, cleanEmoji, cleanNote, cleanFloor, cleanCoords, cleanSubscription,
} from './validate.js';

const JSON_LIMIT = 64 * 1024;
const PROXY_LIMIT = 2 * 1024 * 1024; // Claude 對話可能帶很多地點資料
const ORIGINS = [/^https:\/\/ronchc\.github\.io$/];
const DEV_ORIGINS = [/^http:\/\/localhost(:\d+)?$/]; // 只有 DEV=1 才允許

const PHOTO_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// 不能只信 Content-Type：看檔頭
function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new HttpError(413, 'too_large', '資料太大');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large', '資料太大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = JSON_LIMIT) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v;
  } catch {
    throw new HttpError(400, 'bad_json', '內容不是正確的 JSON');
  }
}

// 來源 IP 當作頻率限制的 key。IPv6 一個人手上通常有整段 /64，所以只看前 4 組，避免換位址就繞過限制
export function ipKey(ip) {
  if (isIP(ip) !== 6) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// 依 TRUST_PROXY 模式取得來源 IP；標頭不可信或格式不對時，一律退回連線本身的 IP
export function clientIpOf(req, trustProxy) {
  let ip = '';
  if (trustProxy === 'cloudflare') {
    ip = String(req.headers['cf-connecting-ip'] || '').trim();
  } else if (trustProxy === 'tailscale') {
    // 使用者可以自己帶 X-Forwarded-For 假裝，但通道會把真正的來源附加在最右邊，只有最右邊可信
    const parts = String(req.headers['x-forwarded-for'] || '').split(',');
    ip = parts[parts.length - 1].trim();
  }
  if (!ip || !isIP(ip)) ip = req.socket.remoteAddress || 'unknown';
  return ipKey(ip.replace(/^::ffff:/i, ''));
}

export function createApp({ config, now = () => Date.now(), fetchImpl = fetch, pushSender } = {}) {
  // 建立暗號太短就拒絕啟動（空白＝沒有人能建立群組，是允許的）
  if (config.createCode && config.createCode.length < MIN_CREATE_CODE) {
    throw new Error(`GROUP_CREATE_CODE 至少要 ${MIN_CREATE_CODE} 個字元（目前 ${config.createCode.length} 個），請重新執行 npm run setup 或自己改長一點`);
  }
  const store = openStore({ dbFile: config.dbFile, dataDir: config.dataDir, now });
  const limiter = createLimiter(now);
  const pusher = createPusher(config, pushSender);
  const allowedOrigin = (o) => ORIGINS.some((re) => re.test(o)) || (config.dev && DEV_ORIGINS.some((re) => re.test(o))) || config.extraOrigins.includes(o);
  const memberLimits = config.limits;

  const clientIp = (req) => clientIpOf(req, config.trustProxy);

  const send = (res, status, body, extra = {}) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(data);
  };

  // ---------- 驗證 ----------
  function tokenOf(req) {
    const h = req.headers.authorization;
    if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
    const k = req.headers['x-api-key']; // Claude SDK 把 apiKey 放在這個標頭
    return typeof k === 'string' ? k.trim() : '';
  }

  // 猜錯權杖／邀請碼／建立暗號：同一個 IP 一分鐘猜太多次就回 429。
  // 只擋「猜錯的人」；持有正確權杖的人不受影響（避免放在通道後面時，一個壞人讓所有人被鎖住）。
  function failed(req) {
    const r = limiter.hit('authFail', clientIp(req), memberLimits.authFail);
    if (!r.ok) throw new HttpError(429, 'too_many_attempts', '嘗試太多次，請稍後再試');
  }

  function auth(req) {
    const token = tokenOf(req);
    const m = token.length >= 20 && token.length <= 200 ? store.memberByToken(token) : null;
    if (!m) {
      failed(req);
      throw new HttpError(401, 'unauthorized', '請重新加入群組');
    }
    if (m.g_expires <= now()) {
      store.deleteGroup(m.group_id);
      throw new HttpError(401, 'group_expired', '這個群組已經到期了');
    }
    return m;
  }

  function limit(bucket, key, cost = 1) {
    const r = limiter.hit(bucket, key, memberLimits[bucket], cost);
    if (!r.ok) throw new HttpError(429, 'rate_limited', `操作太頻繁，請 ${r.retryAfter} 秒後再試`);
  }

  const requireAdmin = (m) => {
    if (!m.is_admin) throw new HttpError(403, 'admin_only', '只有群組管理員可以這樣做');
  };

  // ---------- 輸出整理 ----------
  const pub = (m, mine) => ({
    id: m.id, name: m.name, emoji: m.emoji, tier: m.tier, isAdmin: !!m.is_admin, isMe: m.id === mine,
    lat: m.lat, lng: m.lng, accuracy: m.accuracy, floor: m.floor, note: m.note, locAt: m.loc_at,
  });
  const brief = (m) => (m ? { id: m.id, name: m.name, emoji: m.emoji } : null);

  function stateOf(m) {
    const members = store.members(m.group_id);
    const byId = new Map(members.map((x) => [x.id, x]));
    const since = now() - config.findTtlMs;
    return {
      serverTime: now(),
      me: { ...pub(m, m.id), hasPush: !!m.push_sub },
      group: { id: m.group_id, name: m.g_name, expiresAt: m.g_expires },
      pushEnabled: pusher.enabled,
      members: members.map((x) => pub(x, m.id)),
      asks: store.pendingAsks(m.id, m.group_id, since).map((f) => ({ id: f.id, from: brief(byId.get(f.asker_id)), createdAt: f.created_at })),
      replies: store.unseenReplies(m.id, m.group_id).map((f) => ({
        id: f.id, from: brief(byId.get(f.target_id)), repliedAt: f.replied_at,
        lat: f.lat, lng: f.lng, accuracy: f.accuracy, floor: f.floor, note: f.note, hasPhoto: !!f.photo,
      })),
    };
  }

  async function notifyMember(target, payload) {
    const r = await pusher.notify(target, payload);
    if (r === 'gone') store.setPush(target.id, null);
    return r;
  }

  // ---------- 路由 ----------
  // 每條路由：[方法, 路徑 regex, 是否要登入, 處理函式]
  const routes = [];
  const route = (method, re, authed, fn) => routes.push({ method, re, authed, fn });

  route('GET', /^\/api\/health$/, false, ({ res }) => send(res, 200, { ok: true, push: pusher.enabled }));

  route('GET', /^\/api\/push\/key$/, false, ({ res }) => {
    if (!pusher.enabled || !pusher.publicKey) return send(res, 200, { publicKey: null });
    return send(res, 200, { publicKey: pusher.publicKey });
  });

  route('GET', /^\/api\/emojis$/, false, ({ res }) => send(res, 200, { emojis: EMOJIS }));

  route('POST', /^\/api\/groups$/, false, async ({ req, res }) => {
    const ip = clientIp(req);
    // 只算「猜錯」的：猜錯太多次的這個 IP 先被鎖住（連猜對也不行，否則鎖不住暴力猜測）；
    // 猜對的人不佔額度，所以一個人亂試只會鎖住他自己的 IP，不會鎖死所有人
    const lockedMsg = '建立暗號猜錯太多次，請稍後再試';
    // 先擋一次省得讀 body；但真正的判斷在讀完 body 之後（見下）
    if (!limiter.peek('create', ip, memberLimits.create)) throw new HttpError(429, 'too_many_attempts', lockedMsg);
    const b = await readJson(req);
    // 並發鎖定（L-a）：從這裡到 hit 全部同步執行、中間沒有 await。
    // 否則攻擊者可先開很多連線卡在 body 前，再同時送出，全部都通過上面那次 peek 而繞過 5 次上限
    if (!limiter.peek('create', ip, memberLimits.create)) throw new HttpError(429, 'too_many_attempts', lockedMsg);
    // 沒有建立暗號就不能建群組：管理員＝家人＝能用老闆的金鑰
    if (!config.createCode || typeof b.createCode !== 'string' || !safeEqual(b.createCode, config.createCode)) {
      limiter.hit('create', ip, memberLimits.create);
      failed(req);
      throw new HttpError(403, 'bad_create_code', '建立暗號不正確');
    }
    const r = store.createGroup({
      name: cleanGroupName(b.name), adminName: cleanName(b.memberName), emoji: cleanEmoji(b.emoji), ttlMs: config.groupTtlMs,
    });
    send(res, 201, { groupId: r.groupId, memberId: r.memberId, token: r.adminToken, inviteCode: r.inviteCode, expiresAt: r.expiresAt });
  });

  route('POST', /^\/api\/invite\/info$/, false, async ({ req, res }) => {
    limit('join', clientIp(req));
    const b = await readJson(req);
    const g = typeof b.inviteCode === 'string' && b.inviteCode.length < 200 ? store.groupByInvite(b.inviteCode) : null;
    if (!g || g.expires_at <= now()) throw new HttpError(404, 'invite_invalid', '邀請碼無效或已失效');
    send(res, 200, { groupName: g.name, memberCount: store.memberCount(g.id), expiresAt: g.expires_at });
  });

  route('POST', /^\/api\/join$/, false, async ({ req, res }) => {
    limit('join', clientIp(req));
    const b = await readJson(req);
    const g = typeof b.inviteCode === 'string' && b.inviteCode.length < 200 ? store.groupByInvite(b.inviteCode) : null;
    if (!g) {
      failed(req);
      throw new HttpError(404, 'invite_invalid', '邀請碼無效或已失效');
    }
    if (g.expires_at <= now()) {
      store.deleteGroup(g.id);
      throw new HttpError(404, 'invite_invalid', '邀請碼無效或已失效');
    }
    const name = cleanName(b.name);
    const emoji = cleanEmoji(b.emoji);
    if (store.memberCount(g.id) >= config.maxMembers) throw new HttpError(409, 'group_full', '群組人數已滿');
    const m = store.addMember(g.id, { name, emoji });
    send(res, 201, { groupId: g.id, groupName: g.name, memberId: m.id, token: m.token, tier: 'friend', expiresAt: g.expires_at });
  });

  route('GET', /^\/api\/state$/, true, ({ res, m }) => send(res, 200, stateOf(m)));

  route('POST', /^\/api\/location$/, true, async ({ req, res, m }) => {
    limit('location', m.id);
    const b = await readJson(req);
    const c = cleanCoords(b);
    store.setLocation(m.id, { ...c, floor: cleanFloor(b.floor), note: cleanNote(b.note) });
    send(res, 200, { ok: true });
  });

  route('PUT', /^\/api\/push$/, true, async ({ req, res, m }) => {
    const b = await readJson(req);
    if (!pusher.enabled) throw new HttpError(503, 'push_disabled', '後台沒有開啟推播');
    const sub = cleanSubscription(b.subscription, config.pushHostsExtra);
    store.setPush(m.id, JSON.stringify(sub));
    send(res, 200, { ok: true });
  });
  route('DELETE', /^\/api\/push$/, true, ({ res, m }) => {
    store.setPush(m.id, null);
    send(res, 200, { ok: true });
  });

  // ----- 找人 -----
  route('POST', /^\/api\/find$/, true, async ({ req, res, m }) => {
    const b = await readJson(req);
    const members = store.members(m.group_id).filter((x) => x.id !== m.id);
    let targets;
    if (b.all === true) targets = members;
    else {
      const t = typeof b.targetId === 'string' ? members.find((x) => x.id === b.targetId) : null;
      if (!t) throw new HttpError(404, 'member_not_found', '找不到這個成員');
      targets = [t];
    }
    if (!targets.length) throw new HttpError(400, 'nobody', '群組裡還沒有其他人');
    // 同一對（發問者→目標）冷卻：冷卻中的不再通知（避免連按轟炸同一個人）
    const pairKey = (t) => `${m.id}>${t.id}`;
    const eligible = targets.filter((t) => limiter.peek('findPair', pairKey(t), memberLimits.findPair));
    if (!eligible.length) {
      const wait = Math.max(...targets.map((t) => limiter.retryAfter('findPair', pairKey(t))));
      throw new HttpError(429, 'find_cooldown', `剛剛才問過，請 ${wait} 秒後再問一次`);
    }
    limit('find', m.id, eligible.length); // 一次問全部＝問幾個人就算幾次
    for (const t of eligible) limiter.hit('findPair', pairKey(t), memberLimits.findPair);
    const skipped = targets.filter((t) => !eligible.includes(t));
    const since = now() - config.findTtlMs;
    const out = await Promise.all(eligible.map(async (t) => {
      // 已經問過還沒回的就沿用同一筆（再通知一次），不重複建立
      const open = store.openAsk(m.group_id, m.id, t.id, since);
      const id = open ? open.id : store.createFind(m.group_id, m.id, t.id);
      const pushed = await notifyMember(t, {
        kind: 'ask', findId: id, title: `${m.name} 問你在哪裡？`, body: '點一下回覆你的位置', tag: `ask-${id}`,
      });
      return { id, targetId: t.id, pushed };
    }));
    send(res, 201, { finds: out, skipped: skipped.map((t) => t.id) });
  });

  const findOr404 = (m, id) => {
    const f = store.find(id, m.group_id, m.id);
    if (!f) throw new HttpError(404, 'find_not_found', '找不到這筆找人紀錄');
    return f;
  };

  route('POST', /^\/api\/finds\/([0-9a-f]+)\/reply$/, true, async ({ req, res, m, p }) => {
    const f = findOr404(m, p[0]);
    if (f.target_id !== m.id) throw new HttpError(403, 'not_target', '只有被問的人可以回覆');
    if (f.status !== 'asked') throw new HttpError(409, 'already_replied', '已經回覆過了');
    const b = await readJson(req);
    const c = cleanCoords(b);
    const floor = cleanFloor(b.floor);
    const note = cleanNote(b.note);
    store.replyFind(f.id, { ...c, floor, note });
    store.setLocation(m.id, { ...c, floor, note });
    const asker = store.member(f.asker_id, m.group_id);
    let pushed = 'none';
    if (asker) {
      pushed = await notifyMember(asker, {
        kind: 'reply', findId: f.id, title: `${m.name} 回覆了`, body: [floor, note].filter(Boolean).join('・') || '點開看他的位置', tag: `reply-${f.id}`,
      });
    }
    send(res, 200, { ok: true, pushed });
  });

  route('POST', /^\/api\/finds\/([0-9a-f]+)\/seen$/, true, ({ res, m, p }) => {
    const f = findOr404(m, p[0]);
    if (f.asker_id === m.id) store.markSeen(f.id, m.id);
    send(res, 200, { ok: true });
  });

  route('PUT', /^\/api\/finds\/([0-9a-f]+)\/photo$/, true, async ({ req, res, m, p }) => {
    limit('upload', m.id);
    const f = findOr404(m, p[0]);
    if (f.target_id !== m.id) throw new HttpError(403, 'not_target', '只有被問的人可以上傳照片');
    if (f.status !== 'asked') throw new HttpError(409, 'already_replied', '已經回覆過了，不能再傳照片');
    const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!PHOTO_TYPES[declared]) throw new HttpError(415, 'bad_type', '只接受 jpeg、png、webp 照片');
    const buf = await readBody(req, config.maxPhotoBytes);
    const real = sniffImage(buf);
    if (!real) throw new HttpError(415, 'bad_image', '檔案內容不是正確的照片');
    const name = randomName() + PHOTO_TYPES[real];
    writeFileSync(join(store.photoDir, name), buf, { flag: 'wx' });
    if (f.photo) rmSync(join(store.photoDir, f.photo), { force: true });
    store.setPhoto(f.id, name);
    send(res, 200, { ok: true });
  });

  route('GET', /^\/api\/finds\/([0-9a-f]+)\/photo$/, true, ({ res, m, p }) => {
    const f = findOr404(m, p[0]);
    const file = f.photo && join(store.photoDir, f.photo);
    if (!file || !existsSync(file)) throw new HttpError(404, 'no_photo', '沒有照片');
    const ext = f.photo.slice(f.photo.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    res.end(readFileSync(file));
  });

  // ----- 管理員 -----
  route('PATCH', /^\/api\/members\/([0-9a-f]+)$/, true, async ({ req, res, m, p }) => {
    requireAdmin(m);
    const b = await readJson(req);
    if (b.tier !== 'family' && b.tier !== 'friend') throw new HttpError(400, 'bad_request', 'tier 只能是 family 或 friend');
    const t = store.member(p[0], m.group_id);
    if (!t) throw new HttpError(404, 'member_not_found', '找不到這個成員');
    if (t.is_admin) throw new HttpError(400, 'admin_fixed', '管理員固定是家人');
    store.setTier(t.id, m.group_id, b.tier);
    send(res, 200, { ok: true, tier: b.tier });
  });

  route('DELETE', /^\/api\/members\/([0-9a-f]+)$/, true, ({ res, m, p }) => {
    requireAdmin(m);
    const t = store.member(p[0], m.group_id);
    if (!t) throw new HttpError(404, 'member_not_found', '找不到這個成員');
    if (t.is_admin) throw new HttpError(400, 'admin_fixed', '管理員不能踢自己，要結束請解散群組');
    store.deleteMember(t.id, m.group_id);
    // 踢人後自動重發邀請碼：被踢的人手上若還有舊邀請連結，不能再用它加回來
    send(res, 200, { ok: true, inviteCode: store.resetInvite(m.group_id) });
  });

  route('POST', /^\/api\/invite\/reset$/, true, ({ res, m }) => {
    requireAdmin(m);
    send(res, 200, { inviteCode: store.resetInvite(m.group_id) });
  });

  route('DELETE', /^\/api\/group$/, true, ({ res, m }) => {
    requireAdmin(m);
    store.deleteGroup(m.group_id);
    send(res, 200, { ok: true });
  });

  route('DELETE', /^\/api\/me$/, true, ({ res, m }) => {
    if (m.is_admin) throw new HttpError(400, 'admin_fixed', '管理員要結束請解散群組');
    store.deleteMember(m.id, m.group_id);
    send(res, 200, { ok: true });
  });

  // ---------- 主處理 ----------
  function cors(req, res) {
    const o = req.headers.origin;
    if (!o) return;
    if (!allowedOrigin(o)) throw new HttpError(403, 'origin_not_allowed', '不允許的來源網址');
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
  }

  async function dispatch(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    cors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] || 'authorization, content-type'),
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    // 金鑰代轉
    if (isProxyPath(path)) {
      const m = auth(req);
      store.sweepExpired();
      limit('general', m.id);
      if (m.tier !== 'family') {
        throw new HttpError(403, 'friend_no_proxy', '朋友身分不能使用老闆的金鑰，請自己輸入金鑰');
      }
      if (!proxyKind(path)) throw new HttpError(403, 'path_not_allowed', '這個路徑不開放代轉');
      limit('proxy', m.id);
      const body = await readBody(req, PROXY_LIMIT);
      return forward({ config, store, limiter, fetchImpl }, {
        req, res, url, body, member: m,
        writeCors: (r) => { const o = req.headers.origin; if (o) { r.setHeader('Access-Control-Allow-Origin', o); r.setHeader('Vary', 'Origin'); } },
      });
    }

    if (!path.startsWith('/api/')) throw new HttpError(404, 'not_found', '找不到');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const p = r.re.exec(path);
      if (!p) continue;
      const ctx = { req, res, url, p: p.slice(1) };
      if (r.authed) {
        ctx.m = auth(req);
        limit('general', ctx.m.id);
      } else {
        limit('general', `ip:${clientIp(req)}`);
      }
      return r.fn(ctx);
    }
    throw new HttpError(path.startsWith('/api/') && routes.some((r) => r.re.test(path)) ? 405 : 404, 'not_found', '找不到');
  }

  async function handler(req, res) {
    try {
      await dispatch(req, res);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) {
        const extra = err.status === 429 ? { 'Retry-After': '30' } : {};
        return send(res, err.status, { error: err.code, message: err.message }, extra);
      }
      console.error('內部錯誤：', err?.message); // 不印請求內容，避免權杖進 log
      send(res, 500, { error: 'server_error', message: '後台發生錯誤' });
    }
  }

  const sweep = () => {
    store.sweepExpired();
    store.sweepOrphanPhotos();
  };

  return { handler, store, limiter, sweep, newToken, close: () => store.close() };
}
