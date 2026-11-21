// 驗收 1：建群組、加入、找人、回覆（位置＋樓層＋照片）、推播
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBackend, CREATE_CODE, JPEG, PUSH_ENDPOINT } from './helpers.js';

let s;
before(async () => { s = await startBackend(); });
after(async () => { await s.close(); });

test('沒有建立暗號不能建群組', async () => {
  const r = await s.call('POST', '/api/groups', { body: { createCode: 'wrong', name: 'x', memberName: 'a', emoji: '😎' } });
  assert.equal(r.status, 403);
  const r2 = await s.call('POST', '/api/groups', { body: { name: 'x', memberName: 'a', emoji: '😎' } });
  assert.equal(r2.status, 403);
});

test('輸入檢查：名字、表情、座標、樓層', async () => {
  const g = await s.newGroup();
  const bad = (body) => s.call('POST', '/api/join', { body: { inviteCode: g.inviteCode, ...body } });
  assert.equal((await bad({ name: '', emoji: '🐶' })).status, 400);
  assert.equal((await bad({ name: 'a'.repeat(21), emoji: '🐶' })).status, 400);
  assert.equal((await bad({ name: 'x\u0000y', emoji: '🐶' })).status, 400);
  assert.equal((await bad({ name: '小明', emoji: '<script>' })).status, 400);
  const b = await s.join(g.inviteCode, 'B', '🐱');
  assert.equal((await s.call('POST', '/api/location', { token: b.token, body: { lat: 91, lng: 0 } })).status, 400);
  assert.equal((await s.call('POST', '/api/location', { token: b.token, body: { lat: 25, lng: 121, floor: '99F' } })).status, 400);
  assert.equal((await s.call('POST', '/api/location', { token: b.token, body: { lat: 25, lng: 121, floor: '3F', note: '在手扶梯旁' } })).status, 200);
});

test('A 建群組、B 用邀請碼加入、預設是朋友', async () => {
  const g = await s.newGroup('我們家');
  assert.ok(g.token.length >= 43, '權杖要夠長（256 位元）');
  const info = await s.call('POST', '/api/invite/info', { body: { inviteCode: g.inviteCode } });
  assert.equal(info.json.groupName, '我們家');
  const b = await s.join(g.inviteCode, 'Bob', '🐱');
  assert.equal(b.tier, 'friend');
  const st = await s.call('GET', '/api/state', { token: b.token });
  assert.equal(st.json.me.tier, 'friend');
  assert.equal(st.json.members.length, 2);
  const a = (await s.call('GET', '/api/state', { token: g.token })).json;
  assert.equal(a.me.isAdmin, true);
  assert.equal(a.me.tier, 'family');
  // 成員清單不洩漏權杖、雜湊或推播端點
  const dump = JSON.stringify(st.json) + JSON.stringify(a);
  assert.ok(!/token|push_sub|endpoint|hash/i.test(dump.replace(/"hasPush"/g, '')), '回應不可帶權杖相關欄位');
});

test('找人 → 推播 → 回覆（位置＋樓層＋照片）→ 發問者收到回覆推播並看得到照片', async () => {
  const g = await s.newGroup();
  const b = await s.join(g.inviteCode, 'Bob', '🐱');
  assert.equal((await s.subscribe(b.token, 'bob')).status, 200);
  assert.equal((await s.subscribe(g.token, 'alice')).status, 200);
  s.pushes.length = 0;

  const f = await s.call('POST', '/api/find', { token: g.token, body: { targetId: b.memberId } });
  assert.equal(f.status, 201);
  const findId = f.json.finds[0].id;
  assert.equal(f.json.finds[0].pushed, 'sent');
  assert.equal(s.pushes.length, 1);
  assert.equal(s.pushes[0].endpoint, `${PUSH_ENDPOINT}bob`);
  assert.equal(s.pushes[0].payload.kind, 'ask');
  assert.match(s.pushes[0].payload.title, /老闆 問你在哪裡/);
  assert.equal(s.pushes[0].payload.findId, findId);

  // B 的 App 開著：狀態裡有待回覆的請求
  const bState = (await s.call('GET', '/api/state', { token: b.token })).json;
  assert.equal(bState.asks.length, 1);
  assert.equal(bState.asks[0].from.name, '老闆');

  // 不是被問的人不能回
  assert.equal((await s.call('POST', `/api/finds/${findId}/reply`, { token: g.token, body: { lat: 25, lng: 121 } })).status, 403);

  const up = await s.call('PUT', `/api/finds/${findId}/photo`, { token: b.token, raw: JPEG, headers: { 'Content-Type': 'image/jpeg' } });
  assert.equal(up.status, 200);
  assert.equal(s.photoFiles().length, 1);
  const rep = await s.call('POST', `/api/finds/${findId}/reply`, { token: b.token, body: { lat: 25.0330, lng: 121.5654, accuracy: 12, floor: '3F', note: '我在冰淇淋店前面' } });
  assert.equal(rep.status, 200);
  assert.equal((await s.call('POST', `/api/finds/${findId}/reply`, { token: b.token, body: { lat: 25, lng: 121 } })).status, 409, '不能重複回覆');

  // A 收到「回覆了」推播
  const replyPush = s.pushes.find((p) => p.payload.kind === 'reply');
  assert.ok(replyPush, '發問的人要收到回覆推播');
  assert.equal(replyPush.endpoint, `${PUSH_ENDPOINT}alice`);
  assert.match(replyPush.payload.title, /Bob 回覆了/);

  // A 的狀態：看得到位置、樓層、照片
  const aState = (await s.call('GET', '/api/state', { token: g.token })).json;
  assert.equal(aState.replies.length, 1);
  assert.deepEqual([aState.replies[0].lat, aState.replies[0].floor, aState.replies[0].hasPhoto], [25.033, '3F', true]);
  const photo = await s.call('GET', `/api/finds/${findId}/photo`, { token: g.token });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.ok(photo.buf.equals(JPEG));
  // 位置也更新到成員清單
  const bm = aState.members.find((m) => m.name === 'Bob');
  assert.equal(bm.floor, '3F');

  await s.call('POST', `/api/finds/${findId}/seen`, { token: g.token });
  assert.equal((await s.call('GET', '/api/state', { token: g.token })).json.replies.length, 0);
  // 回覆後 B 不再有待回覆
  assert.equal((await s.call('GET', '/api/state', { token: b.token })).json.asks.length, 0);
});

test('找全部人：每位都收到推播；失效的訂閱會被清掉', async () => {
  const g = await s.newGroup();
  const b = await s.join(g.inviteCode, 'B');
  const c = await s.join(g.inviteCode, 'C');
  await s.subscribe(b.token, 'b2');
  await s.subscribe(c.token, 'gone-c');
  s.pushes.length = 0;
  const f = await s.call('POST', '/api/find', { token: g.token, body: { all: true } });
  assert.equal(f.json.finds.length, 2);
  const byTarget = Object.fromEntries(f.json.finds.map((x) => [x.targetId, x.pushed]));
  assert.equal(byTarget[b.memberId], 'sent');
  assert.equal(byTarget[c.memberId], 'gone');
  assert.equal((await s.call('GET', '/api/state', { token: c.token })).json.me.hasPush, false, '410 的訂閱要清掉');
  // 沒有訂閱的人（App 開著時靠輪詢）也會有待回覆
  assert.equal((await s.call('GET', '/api/state', { token: c.token })).json.asks.length, 1);
});

test('同一個人還沒回覆就再按找他：沿用同一筆，不重複', async () => {
  const g = await s.newGroup();
  const b = await s.join(g.inviteCode, 'B');
  const f1 = await s.call('POST', '/api/find', { token: g.token, body: { targetId: b.memberId } });
  const f2 = await s.call('POST', '/api/find', { token: g.token, body: { targetId: b.memberId } });
  assert.equal(f1.json.finds[0].id, f2.json.finds[0].id);
  assert.equal((await s.call('GET', '/api/state', { token: b.token })).json.asks.length, 1);
});

test('找人逾時後不再提示', async () => {
  const g = await s.newGroup();
  const b = await s.join(g.inviteCode, 'B');
  await s.call('POST', '/api/find', { token: g.token, body: { targetId: b.memberId } });
  s.clock.t += s.config.findTtlMs + 1000;
  assert.equal((await s.call('GET', '/api/state', { token: b.token })).json.asks.length, 0);
});

test('不能找自己、不能找不存在的人', async () => {
  const g = await s.newGroup();
  assert.equal((await s.call('POST', '/api/find', { token: g.token, body: { targetId: g.memberId } })).status, 404);
  assert.equal((await s.call('POST', '/api/find', { token: g.token, body: { all: true } })).status, 400);
});

test('管理員：改身分、踢人、重發邀請碼（舊碼失效）；朋友不能做', async () => {
  const g = await s.newGroup();
  const b = await s.join(g.inviteCode, 'B');
  const c = await s.join(g.inviteCode, 'C');
  assert.equal((await s.call('PATCH', `/api/members/${c.memberId}`, { token: b.token, body: { tier: 'family' } })).status, 403);
  assert.equal((await s.call('DELETE', `/api/members/${c.memberId}`, { token: b.token })).status, 403);
  assert.equal((await s.call('POST', '/api/invite/reset', { token: b.token })).status, 403);
  assert.equal((await s.call('DELETE', '/api/group', { token: b.token })).status, 403);
  assert.equal((await s.call('PATCH', `/api/members/${g.memberId}`, { token: g.token, body: { tier: 'friend' } })).status, 400, '管理員不能被降級');
  assert.equal((await s.call('PATCH', `/api/members/${b.memberId}`, { token: g.token, body: { tier: 'family' } })).status, 200);
  assert.equal((await s.call('PATCH', `/api/members/${b.memberId}`, { token: g.token, body: { tier: 'admin' } })).status, 400);

  const reset = await s.call('POST', '/api/invite/reset', { token: g.token });
  assert.equal(reset.status, 200);
  assert.notEqual(reset.json.inviteCode, g.inviteCode);
  assert.equal((await s.call('POST', '/api/join', { body: { inviteCode: g.inviteCode, name: 'D', emoji: '🐶' } })).status, 404, '舊邀請碼失效');
  assert.equal((await s.call('POST', '/api/join', { body: { inviteCode: reset.json.inviteCode, name: 'D', emoji: '🐶' } })).status, 201);

  assert.equal((await s.call('DELETE', `/api/members/${c.memberId}`, { token: g.token })).status, 200);
  assert.equal((await s.call('GET', '/api/state', { token: c.token })).status, 401, '被踢的人馬上失效');
});

test('群組人數上限', async () => {
  const small = await startBackend({ maxMembers: 2 });
  try {
    const g = await small.newGroup();
    await small.join(g.inviteCode, 'B');
    const r = await small.call('POST', '/api/join', { body: { inviteCode: g.inviteCode, name: 'C', emoji: '🐶' } });
    assert.equal(r.status, 409);
  } finally { await small.close(); }
});

test('推播訂閱只接受已知推播服務', async () => {
  const g = await s.newGroup();
  const evil = { endpoint: 'https://evil.example.com/x', keys: { p256dh: 'BPxxxxxxxxxxxxxxxxxxxxxxxx', auth: 'authauthauth1234' } };
  assert.equal((await s.call('PUT', '/api/push', { token: g.token, body: { subscription: evil } })).status, 400);
  const local = { endpoint: 'https://localhost/x', keys: evil.keys };
  assert.equal((await s.call('PUT', '/api/push', { token: g.token, body: { subscription: local } })).status, 400);
  assert.equal((await s.call('PUT', '/api/push', { token: g.token, body: { subscription: { ...evil, endpoint: 'http://fcm.googleapis.com/x' } } })).status, 400);
});

test('建立暗號沒設定時，沒有人能建群組', async () => {
  const closed = await startBackend({ createCode: '' });
  try {
    const r = await closed.call('POST', '/api/groups', { body: { createCode: '', name: 'x', memberName: 'a', emoji: '😎' } });
    assert.equal(r.status, 403);
  } finally { await closed.close(); }
});

test('CREATE_CODE 常數存在（避免測試檔拼錯）', () => assert.ok(CREATE_CODE));
