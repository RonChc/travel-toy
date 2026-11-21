// 端對端測試：真的起後台＋靜態網站，用兩個瀏覽器環境（A＝管理員、B＝成員）走完整流程並截圖。
// 用法：node e2e/run.mjs      （需要 Chromium：預設找 ms-playwright 快取，或用 CHROME_PATH 指定）
// 推播：Chromium 無法直接收 FCM，這裡由後台的「假推播 sender」收到訊息後，用 CDP 的 deliverPushMessage
//       把同一份內容送進瀏覽器的 Service Worker，驗證 SW 顯示通知、點開回覆的整條路（不含 FCM 傳輸本身）。
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { chromium } from 'playwright-core';
import { startBackend, GOOGLE_KEY, CLAUDE_KEY } from '../test/helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const WEB_PORT = 5199;
const WEB = `http://localhost:${WEB_PORT}`;

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(base)) {
    for (const d of readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      const p = join(base, d, 'chrome-win64', 'chrome.exe');
      if (existsSync(p)) return p;
    }
  }
  throw new Error('找不到 Chromium，請用 CHROME_PATH 指定');
}

const results = [];
let failed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - t0 });
    console.log(`✔ ${name}${detail ? `  → ${detail}` : ''}`);
  } catch (e) {
    failed++;
    results.push({ name, ok: false, detail: String(e?.message || e) });
    console.log(`✖ ${name}\n   ${String(e?.stack || e).split('\n').slice(0, 4).join('\n   ')}`);
  }
}
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 啟動：後台＋靜態網站 ----------
const backend = await startBackend({ claudeDailyLimit: 50 });
const web = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs'), String(WEB_PORT)], { stdio: 'ignore' });
await sleep(800);
const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--use-fake-ui-for-media-stream'] });

const consoleErrors = { A: [], B: [] };
const siteRequests = []; // B 送給靜態網站（GitHub Pages 角色）的所有請求網址
const responses = { B: [] }; // B 收到的所有後台回應內容（驗證沒有金鑰）

async function newUser(label, geo) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
    geolocation: geo, permissions: ['geolocation', 'notifications'],
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors[label].push(m.text()); });
  page.on('pageerror', (e) => consoleErrors[label].push(`pageerror: ${e.message}`));
  if (label === 'B') {
    page.on('request', (r) => { if (r.url().startsWith(WEB)) siteRequests.push(r.url()); });
    page.on('response', async (r) => {
      if (r.url().startsWith(backend.base)) responses.B.push({ url: r.url(), status: r.status(), text: await r.text().catch(() => '') });
    });
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const regs = new Map();
  cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => registrations.forEach((r) => regs.set(r.registrationId, r)));
  return { label, context, page, cdp, regs, key: label };
}

// 把後台發出的推播，原封不動送進對應使用者的 Service Worker
const byEndpoint = new Map();
backend.onPush = async (rec) => {
  const u = byEndpoint.get(rec.endpoint);
  if (!u) return;
  const reg = [...u.regs.values()].find((r) => r.scopeURL.startsWith(WEB));
  if (reg) await u.cdp.send('ServiceWorker.deliverPushMessage', { origin: WEB, registrationId: reg.registrationId, data: JSON.stringify(rec.payload) });
};

const shot = (u, name) => u.page.screenshot({ path: join(OUT, `${name}.png`) });
const toastText = (u) => u.page.locator('#toast').textContent();

async function notifications(u) {
  return u.page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }));
  });
}
// 在頁面裡每 100ms 記錄一次出現過的系統通知（App 開著時頁面會把已處理的通知關掉，事後查不到）
async function watchNotifications(u) {
  await u.page.evaluate(() => {
    window.__seen = [];
    setInterval(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      for (const n of await reg.getNotifications()) {
        if (!window.__seen.some((x) => x.tag === n.tag)) window.__seen.push({ tag: n.tag, title: n.title, body: n.body, data: n.data, at: Date.now() });
      }
    }, 100);
  });
}
const seenNotifications = (u) => u.page.evaluate(() => window.__seen);
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`等不到：${what}（${ms}ms）`);
}

const A = await newUser('A', { latitude: 25.033, longitude: 121.5654, accuracy: 10 });
const B = await newUser('B', { latitude: 25.034, longitude: 121.566, accuracy: 15 });
let inviteLink;
let findId;

try {
  // ===== 1. A 建立群組 =====
  await step('A：打開 App、設定群組伺服器網址、建立群組', async () => {
    await A.page.goto(WEB);
    await A.page.waitForSelector('#origin-label');
    await A.page.click('#open-settings');
    await A.page.fill('#group-server', backend.base);
    await A.page.click('#settings-form button[value="save"]');
    await A.page.click('.view-btn[data-view="group"]');
    await A.page.click('#group-create');
    await A.page.fill('#gc-name', '週末出遊');
    await A.page.fill('#gc-code', backend.config.createCode);
    await A.page.fill('#gc-me', '老闆');
    await A.page.click('#gc-submit');
    await A.page.waitForSelector('#group-on:not([hidden])');
    await A.page.waitForSelector('#group-invite input');
    inviteLink = await A.page.inputValue('#group-invite input');
    check(inviteLink.includes('#join=') && inviteLink.includes('server=') && !inviteLink.includes('?'), '邀請連結要帶邀請碼與伺服器網址，且放在 # 後面');
    check(await A.page.locator('#group-invite img.qr').count() === 1, '要顯示 QR');
    await shot(A, '01-A建立群組-邀請QR');
    return inviteLink.replace(/join=[^&]+/, 'join=***');
  });

  // ===== 2. B 用邀請連結加入 =====
  await step('B：開邀請連結 → 輸入名字選表情 → 加入（預設是朋友）', async () => {
    await B.page.goto(inviteLink);
    await B.page.waitForSelector('#group-join-dialog[open]');
    await shot(B, '02-B加入視窗');
    await B.page.fill('#gj-name', '小明');
    await B.page.locator('#gj-emoji label').nth(4).click();
    await B.page.click('#gj-submit');
    await B.page.waitForSelector('#group-on:not([hidden])');
    await B.page.waitForSelector('#group-members li');
    const tier = await B.page.textContent('#group-tier');
    check(tier.includes('朋友'), `B 應該是朋友：${tier}`);
    await shot(B, '03-B加入後-成員清單');
  });

  await step('B：成員清單看得到彼此（名字、表情、身分），網址參數已清掉', async () => {
    await waitFor(async () => (await B.page.locator('#group-members li').count()) === 2, 8000, 'B 成員清單 2 人');
    const names = await B.page.locator('#group-members .m-name').allTextContents();
    check(names.some((t) => t.includes('老闆')) && names.some((t) => t.includes('小明')), names.join('|'));
    check(!B.page.url().includes('join='), 'join 參數應清掉（避免邀請碼留在網址列）');
    check(!siteRequests.some((u) => u.includes('join=')), `邀請碼不應出現在送給網站主機的請求網址：${siteRequests.filter((u) => u.includes('join=')).join(',')}`);
  });

  // ===== 3. B 開啟通知（訂閱）=====
  await step('B／A：開啟通知並向後台登記訂閱', async () => {
    const out = [];
    for (const u of [A, B]) {
      // 真正的 pushManager.subscribe 需要 FCM；測試環境的 Chromium 通常做不到，失敗就改用假訂閱登記（流程相同）
      const real = await u.page.evaluate(async (key) => {
        try {
          const reg = await navigator.serviceWorker.ready;
          const sub = await Promise.race([
            reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(65).fill(4) }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
          ]);
          return sub.endpoint;
        } catch (e) { return `ERR:${e.message}`; }
      });
      out.push(`${u.label} 真實訂閱：${real.startsWith('ERR:') ? real : '成功'}`);
      const token = await u.page.evaluate(() => JSON.parse(localStorage.getItem('travel-toy-group')).token);
      const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${u.label}`;
      byEndpoint.set(endpoint, u);
      const r = await backend.call('PUT', '/api/push', { token, body: { subscription: { endpoint, keys: { p256dh: 'BPxxxxxxxxxxxxxxxxxxxxxxxx', auth: 'authauthauth1234' } } } });
      check(r.status === 200, `登記訂閱失敗 ${r.status}`);
    }
    return out.join('；');
  });

  // ===== 4. A 找 B =====
  await step('A 按「找他」→ B 在 10 秒內收到系統通知，且 App 內跳出回覆視窗', async () => {
    await A.page.reload();
    await A.page.waitForSelector('#group-members li .find-btn');
    await watchNotifications(A);
    await watchNotifications(B);
    const t0 = Date.now();
    await A.page.click('#group-members li .find-btn');
    const notes = await waitFor(async () => { const n = await seenNotifications(B); return n.length ? n : null; }, 10000, 'B 的系統通知');
    const took = Date.now() - t0;
    check(took < 10000, `通知花了 ${took}ms`);
    check(/老闆 問你在哪裡/.test(notes[0].title), `通知標題：${notes[0].title}`);
    findId = notes[0].data.findId;
    await waitFor(() => B.page.locator('#find-dialog[open]').count(), 8000, 'B 的回覆視窗（App 開著）');
    await shot(B, '04-B收到找人-回覆視窗');
    return `通知 ${took}ms：「${notes[0].title}／${notes[0].body}」`;
  });

  await step('點通知打開 App（通知點擊網址）：?find= 參數會直接開回覆視窗', async () => {
    const page3 = await B.context.newPage();
    page3.on('console', (m) => { if (m.type() === 'error') consoleErrors.B.push(m.text()); });
    await page3.goto(`${WEB}/?find=${findId}&kind=ask`);
    await page3.waitForSelector('#find-dialog[open]', { timeout: 8000 });
    const title = await page3.textContent('#fd-title');
    await page3.close();
    check(/老闆/.test(title), title);
  });

  // ===== 5. B 回覆：位置＋樓層＋照片＋一句話 =====
  await step('B 回覆：位置＋樓層 3F＋照片（3000×2000 壓到 1280 內）＋一句話', async () => {
    await B.page.selectOption('#fd-floor', '3F');
    await B.page.fill('#fd-note', '我在冰淇淋店前面');
    // 在頁面裡產生一張 3000×2000 的大照片，模擬手機拍照
    await B.page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 3000; c.height = 2000;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 3000, 2000);
      grad.addColorStop(0, '#f97316'); grad.addColorStop(1, '#0d9488');
      g.fillStyle = grad; g.fillRect(0, 0, 3000, 2000);
      g.fillStyle = '#fff'; g.font = 'bold 260px sans-serif'; g.fillText('🍦 冰淇淋店', 300, 1100);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'IMG_0001.png', { type: 'image/png' }));
      const input = document.querySelector('#fd-photo-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await B.page.waitForSelector('#fd-preview:not([hidden])');
    await shot(B, '05-B回覆視窗-已拍照');
    await B.page.click('#fd-submit');
    await waitFor(async () => !(await B.page.locator('#find-dialog[open]').count()), 10000, '回覆視窗關閉');
    const files = backend.photoFiles();
    check(files.length === 1 && /\.jpg$/.test(files[0]), `後台照片：${files}`);
    return `後台檔案 ${files[0]}`;
  });

  await step('A 收到「〇〇 回覆了」通知，點開看得到地圖、樓層、照片（1280px 內）', async () => {
    const notes = await waitFor(async () => { const n = await seenNotifications(A); return n.find((x) => /回覆了/.test(x.title)) ? n : null; }, 10000, 'A 的回覆通知');
    const note = notes.find((x) => /回覆了/.test(x.title));
    await waitFor(() => A.page.locator('#find-result-dialog[open]').count(), 8000, 'A 的結果視窗');
    await waitFor(() => A.page.locator('#fr-photo:not([hidden])').count(), 8000, '照片載入');
    const dim = await A.page.evaluate(() => { const i = document.querySelector('#fr-photo'); return [i.naturalWidth, i.naturalHeight]; });
    check(Math.max(...dim) <= 1280 && Math.max(...dim) > 600, `照片尺寸 ${dim}`);
    const info = await A.page.textContent('#fr-info');
    check(info.includes('3F') && info.includes('冰淇淋店前面'), info);
    const src = await A.page.getAttribute('#fr-map', 'src');
    check(src.includes('openstreetmap.org') && src.includes('marker=25.034,121.566'), src);
    await sleep(6000); // 讓地圖圖磚載入一下再截圖
    await shot(A, '06-A收到回覆-地圖與照片');
    return `通知「${note.title}／${note.body}」照片 ${dim.join('×')}`;
  });

  await step('A 關掉結果後，成員清單顯示 B 的樓層與位置、可導航', async () => {
    await A.page.click('#fr-close');
    await waitFor(async () => (await A.page.locator('#group-members li', { hasText: '小明' }).textContent()).includes('3F'), 8000, '成員清單更新')
      .catch(async (e) => { await shot(A, 'debug-成員清單'); throw new Error(`${e.message}；目前：${(await A.page.locator('#group-members').textContent()).replace(/\s+/g, ' ')}`); });
    const row = await A.page.locator('#group-members li', { hasText: '小明' }).textContent();
    check(/離你/.test(row) && /3F/.test(row), row);
    check(await A.page.locator('#group-members li', { hasText: '小明' }).locator('a.nav-btn').count() === 1, '要有導航按鈕');
    await shot(A, '07-A成員清單-B的位置');
    return row.replace(/\s+/g, ' ');
  });

  // ===== 6. 權限：朋友／家人 =====
  await step('B（朋友）打開附近、點類別：不能用老闆的金鑰，畫面提示自己輸入金鑰', async () => {
    await B.page.click('.view-btn[data-view="nearby"]');
    await waitFor(async () => (await B.page.textContent('#origin-label')).includes('目前位置'), 8000, 'B 定位');
    const banner = await B.page.locator('#key-banner').isVisible();
    check(banner, '朋友沒金鑰時要顯示提示橫幅');
    await B.page.click('.cat[data-id]');
    await waitFor(() => B.page.locator('#settings[open]').count(), 4000, '跳出設定');
    const t = await toastText(B);
    check(/朋友.*自己輸入/.test(t), t);
    await shot(B, '08-B朋友-請自己輸入金鑰');
    await B.page.click('#settings-form button[value="cancel"]');
    return t;
  });

  await step('直接用 B 的權杖打 proxy：朋友被拒 403', async () => {
    const token = await B.page.evaluate(() => JSON.parse(localStorage.getItem('travel-toy-group')).token);
    const r = await backend.call('POST', '/api/proxy/google/places/searchNearby', { token, body: { includedTypes: ['park'] }, headers: { 'X-Goog-FieldMask': 'places.id' } });
    check(r.status === 403 && r.json.error === 'friend_no_proxy', `${r.status} ${r.text}`);
    return `HTTP ${r.status} ${r.json.error}`;
  });

  await step('A 把 B 改成「家人」→ B 不輸入金鑰就能搜附近（走後台代轉，用假上游）', async () => {
    await A.page.reload();
    await A.page.waitForSelector('#group-members li select');
    await A.page.locator('#group-members li select').first().selectOption('family');
    await waitFor(async () => (await B.page.textContent('#key-banner')) && !(await B.page.locator('#key-banner').isVisible()), 10000, 'B 的橫幅消失（身分更新）');
    backend.upstream.calls.length = 0;
    await B.page.click('.cat[data-id]');
    await B.page.waitForSelector('#results .card', { timeout: 10000 });
    const name = await B.page.locator('#results .card .name').first().textContent();
    check(name === '假店家', name);
    await shot(B, '09-B家人-走代轉搜到附近');
    const used = backend.upstream.calls.filter((c) => c.url.includes('places:search'));
    check(used.length >= 1, '上游要收到請求');
    check(used[0].headers['x-goog-api-key'] === GOOGLE_KEY, '後台代呼叫要帶老闆的金鑰');
    check(used[0].headers.referer === 'https://ronchc.github.io/', 'Referer');
    return `搜到「${name}」；上游收到 ${used.length} 次，金鑰只在後台→上游這一段`;
  });

  await step('B（家人）「AI 幫我挑」也走代轉（Claude SDK baseURL 指向後台、x-api-key 放權杖）', async () => {
    backend.upstream.calls.length = 0;
    await B.page.click('#ai-pick');
    await waitFor(async () => (await B.page.locator('#ai-box').isVisible()), 20000, 'AI 回覆');
    const text = await B.page.textContent('#ai-box');
    check(text.includes('假 AI'), text);
    const c = backend.upstream.calls.find((x) => x.url.startsWith('/v1/messages'));
    check(c && c.headers['x-api-key'] === CLAUDE_KEY, '上游收到的是老闆的 Claude 金鑰');
    await shot(B, '10-B家人-AI幫我挑走代轉');
    return '上游收到 Claude 請求，金鑰由後台帶入';
  });

  await step('B 手機裡完全看不到老闆的金鑰（localStorage、所有後台回應、頁面文字）', async () => {
    const ls = await B.page.evaluate(() => JSON.stringify({ ...localStorage }));
    const body = await B.page.evaluate(() => document.documentElement.outerHTML);
    const resp = responses.B.map((r) => r.url + r.text).join('\n');
    const shapes = [/AIza[0-9A-Za-z_-]{20,}/, /sk-ant-[0-9A-Za-z_-]{10,}/];
    for (const [where, text] of [['localStorage', ls], ['頁面', body], ['後台回應', resp]]) {
      for (const secret of [GOOGLE_KEY, CLAUDE_KEY]) check(!text.includes(secret), `${where}含金鑰 ${secret.slice(0, 8)}…`);
      for (const re of shapes) check(!re.test(text), `${where}含看起來像金鑰的字串 ${re}`);
    }
    const keys = await B.page.evaluate(() => JSON.parse(localStorage.getItem('travel-toy-prefs') || '{}'));
    check(!keys.key && !keys.claudeKey, '偏好設定裡沒有金鑰');
    return `檢查了 ${responses.B.length} 個後台回應`;
  });

  await step('A 改回「朋友」→ B 再搜馬上被拒、畫面提示自己輸入金鑰', async () => {
    await A.page.locator('#group-members li select').first().selectOption('friend');
    await sleep(500);
    // 不等輪詢，B 立刻再搜一次（身分在後台已經改了）
    await B.page.click('.cat[data-id]:nth-child(2)');
    await waitFor(async () => /朋友/.test(await B.page.textContent('#status')), 8000, 'B 狀態提示');
    const st = await B.page.textContent('#status');
    check(/自己輸入金鑰/.test(st), st);
    await waitFor(() => B.page.locator('#key-banner').isVisible(), 8000, '橫幅回來');
    await shot(B, '11-B被改回朋友-馬上被拒');
    return st;
  });

  // ===== 7. 解散 =====
  await step('A 解散群組 → 後台資料與照片檔案全刪、B 被登出', async () => {
    check(backend.photoFiles().length === 1, '解散前有 1 張照片');
    A.page.once('dialog', (d) => d.accept());
    await A.page.click('#group-leave');
    await waitFor(async () => (await A.page.locator('#group-off').isVisible()), 8000, 'A 回到未加入畫面');
    const n = (t) => backend.app.store.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    check(n('groups') === 0 && n('members') === 0 && n('finds') === 0, '資料表要清空');
    check(backend.photoFiles().length === 0, '照片檔案要刪掉');
    await waitFor(async () => (await B.page.evaluate(() => localStorage.getItem('travel-toy-group'))) === null, 12000, 'B 被登出');
    await B.page.click('.view-btn[data-view="group"]');
    await shot(B, '12-解散後-B回到未加入');
    return '成員、位置、找人紀錄、照片檔案都已刪除';
  });

  // ===== 8. 原本功能：?mock 測試模式、版面 =====
  await step('?mock 測試模式照常能用（搜類別、有結果卡片）、主控台 0 錯誤、390px 不跑版', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-TW', geolocation: { latitude: 25.033, longitude: 121.5654 }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    await page.goto(`${WEB}/?mock`);
    await page.waitForSelector('#origin-label');
    await waitFor(async () => (await page.textContent('#origin-label')).includes('目前位置'), 8000, '定位');
    await page.click('.cat[data-id]');
    await page.waitForSelector('#results .card', { timeout: 10000 });
    const cards = await page.locator('#results .card').count();
    check(cards > 0, '要有結果');
    await page.screenshot({ path: join(OUT, '13-mock模式-附近搜尋.png') });
    for (const view of ['route', 'plan', 'group']) {
      await page.click(`.view-btn[data-view="${view}"]`);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(over <= 0, `${view} 分頁橫向溢出 ${over}px`);
      await page.screenshot({ path: join(OUT, `14-mock模式-${view}分頁.png`) });
    }
    check(errs.length === 0, `主控台錯誤：${errs.join(' | ')}`);
    await ctx.close();
    return `${cards} 間結果，4 個分頁都沒有橫向溢出`;
  });

  await step('群組畫面（已加入狀態）在 390px 寬沒有橫向溢出', async () => {
    const over = await A.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 0, `溢出 ${over}px`);
  });

  await step('主控台錯誤：A、B 兩邊（排除「朋友被拒」那次預期的 403 資源錯誤）', async () => {
    // 排除：① 朋友被拒的 403、② 群組解散後 B 的舊權杖 401（都是測試刻意觸發的資源錯誤）
    // ③ Playwright 的無痕環境不支援 Push API（測試腳本自己呼叫 pushManager.subscribe 才會出現，真機不會）
    const real = (list) => list.filter((e) => !/status of (403|401)|Push API in incognito/.test(e));
    const a = real(consoleErrors.A);
    const b = real(consoleErrors.B);
    check(a.length === 0 && b.length === 0, `A：${a.join(' | ')}；B：${b.join(' | ')}`);
    return `預期內的 403 共 ${consoleErrors.B.length - b.length + consoleErrors.A.length - a.length} 則`;
  });
} finally {
  await browser.close().catch(() => {});
  web.kill();
  writeFileSync(join(OUT, 'result.json'), JSON.stringify({ results, consoleErrors }, null, 2));
  await backend.close();
}

console.log(`\n${results.length - failed}/${results.length} 通過，截圖在 ${OUT}`);
process.exit(failed ? 1 : 0);
