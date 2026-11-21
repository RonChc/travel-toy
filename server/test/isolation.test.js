// 驗收 4：不同群組互相看不到；亂猜權杖拿不到東西；頻率限制；CORS
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startBackend, JPEG } from './helpers.js';

let s;
before(async () => { s = await startBackend(); });
after(async () => { await s.close(); });

async function twoGroups() {
  const a = await s.newGroup('A 群');
  const a2 = await s.join(a.inviteCode, 'A成員');
  const b = await s.newGroup('B 群');
  const b2 = await s.join(b.inviteCode, 'B成員');
  return { a, a2, b, b2 };
}

test('A 群的權杖看不到 B 群的成員、位置、找人、照片', async () => {
  const { a, a2, b, b2 } = await twoGroups();
  await s.call('POST', '/api/location', { token: b2.token, body: { lat: 25.1, lng: 121.1, floor: '5F' } });
  const f = await s.call('POST', '/api/find', { token: b.token, body: { targetId: b2.memberId } });
  const findId = f.json.finds[0].id;
  await s.call('PUT', `/api/finds/${findId}/photo`, { token: b2.token, raw: JPEG, headers: { 'Content-Type': 'image/jpeg' } });

  // A 群看自己的狀態：沒有 B 群的人
  const st = (await s.call('GET', '/api/state', { token: a.token })).json;
  const names = st.members.map((m) => m.name);
  assert.deepEqual(names.sort(), ['A成員', '老闆'].sort());
  assert.ok(!JSON.stringify(st).includes('B成員'));

  // 用 B 群的 id 去碰：全部 404
  for (const t of [a.token, a2.token]) {
    assert.equal((await s.call('GET', `/api/finds/${findId}/photo`, { token: t })).status, 404);
    assert.equal((await s.call('POST', `/api/finds/${findId}/reply`, { token: t, body: { lat: 1, lng: 1 } })).status, 404);
    assert.equal((await s.call('PUT', `/api/finds/${findId}/photo`, { token: t, raw: JPEG, headers: { 'Content-Type': 'image/jpeg' } })).status, 404);
    assert.equal((await s.call('POST', `/api/finds/${findId}/seen`, { token: t })).status, 404);
  }
  assert.equal((await s.call('POST', '/api/find', { token: a.token, body: { targetId: b2.memberId } })).status, 404, '不能找別群的人');
  assert.equal((await s.call('PATCH', `/api/members/${b2.memberId}`, { token: a.token, body: { tier: 'family' } })).status, 404, 'A 群管理員不能動 B 群的人');
  assert.equal((await s.call('DELETE', `/api/members/${b2.memberId}`, { token: a.token })).status, 404);
  // B 群的人還在
  assert.equal((await s.call('GET', '/api/state', { token: b2.token })).status, 200);

  // A 管理員解散 A 群不影響 B 群
  await s.call('DELETE', '/api/group', { token: a.token });
  assert.equal((await s.call('GET', '/api/state', { token: b.token })).status, 200);
  assert.equal(s.photoFiles().length, 1);
});

test('同一個群組裡，不相關的第三人看不到別人的找人紀錄與照片', async () => {
  const g = await s.newGroup();
  const b = await s.join(g.inviteCode, 'B');
  const c = await s.join(g.inviteCode, 'C');
  const f = await s.call('POST', '/api/find', { token: g.token, body: { targetId: b.memberId } });
  const id = f.json.finds[0].id;
  await s.call('PUT', `/api/finds/${id}/photo`, { token: b.token, raw: JPEG, headers: { 'Content-Type': 'image/jpeg' } });
  await s.call('POST', `/api/finds/${id}/reply`, { token: b.token, body: { lat: 25, lng: 121 } });
  assert.equal((await s.call('GET', `/api/finds/${id}/photo`, { token: c.token })).status, 404);
  assert.equal((await s.call('GET', `/api/finds/${id}/photo`, { token: g.token })).status, 200);
  const cs = (await s.call('GET', '/api/state', { token: c.token })).json;
  assert.equal(cs.replies.length, 0);
  assert.equal(cs.asks.length, 0);
});

test('亂猜權杖、邀請碼拿不到東西', async () => {
  await s.newGroup();
  for (let i = 0; i < 20; i++) {
    const guess = randomBytes(32).toString('base64url');
    assert.equal((await s.call('GET', '/api/state', { token: guess })).status, 401);
    assert.equal((await s.call('POST', '/api/join', { body: { inviteCode: guess, name: 'x', emoji: '🐶' } })).status, 404);
  }
  for (const bad of ['', 'a', "' OR 1=1 --", '../../etc/passwd', 'x'.repeat(5000), 'Bearer']) {
    assert.equal((await s.call('GET', '/api/state', { token: bad })).status, 401, `權杖 ${bad.slice(0, 20)}`);
  }
  assert.equal((await s.call('GET', '/api/state')).status, 401);
  // 邀請碼不能拿來當成員權杖
  const g = await s.newGroup();
  assert.equal((await s.call('GET', '/api/state', { token: g.inviteCode })).status, 401);
});

test('資料庫只存權杖雜湊，不存原文', async () => {
  const g = await s.newGroup();
  const b = await s.join(g.inviteCode, 'B');
  const dump = JSON.stringify([
    s.app.store.db.prepare('SELECT * FROM members').all(),
    s.app.store.db.prepare('SELECT * FROM groups').all(),
  ]);
  for (const secret of [g.token, b.token, g.inviteCode]) assert.ok(!dump.includes(secret), '資料庫裡不能有權杖／邀請碼原文');
});

test('一直猜錯會被鎖住（429），正確的權杖在鎖住期間也先擋', async () => {
  const lim = await startBackend({ limits: { authFail: { max: 5, windowMs: 60e3 } } });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await lim.call('GET', '/api/state', { token: randomBytes(32).toString('base64url') })).status, 401);
    const r = await lim.call('GET', '/api/state', { token: randomBytes(32).toString('base64url') });
    assert.equal(r.status, 429);
    assert.ok(r.headers.get('retry-after'));
    lim.clock.t += 61e3;
    assert.equal((await lim.call('GET', '/api/state', { token: randomBytes(32).toString('base64url') })).status, 401, '時間過了就解除');
  } finally { await lim.close(); }
});

test('頻率限制：找人、上傳、代轉', async () => {
  const lim = await startBackend({ limits: { find: { max: 2, windowMs: 60e3 }, upload: { max: 2, windowMs: 60e3 }, proxy: { max: 2, windowMs: 60e3 } } });
  try {
    const g = await lim.newGroup();
    const b = await lim.join(g.inviteCode, 'B');
    const find = () => lim.call('POST', '/api/find', { token: g.token, body: { targetId: b.memberId } });
    assert.equal((await find()).status, 201);
    assert.equal((await find()).status, 201);
    assert.equal((await find()).status, 429);
    const findId = (await lim.call('GET', '/api/state', { token: b.token })).json.asks[0].id;
    const up = () => lim.call('PUT', `/api/finds/${findId}/photo`, { token: b.token, raw: JPEG, headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal((await up()).status, 200);
    assert.equal((await up()).status, 200);
    assert.equal((await up()).status, 429);
    const px = () => lim.call('POST', '/api/proxy/google/places/searchText', { token: g.token, body: {}, headers: { 'X-Goog-FieldMask': 'places.id' } });
    assert.equal((await px()).status, 200);
    assert.equal((await px()).status, 200);
    assert.equal((await px()).status, 429);
    lim.clock.t += 61e3;
    assert.equal((await find()).status, 201, '視窗過了恢復');
  } finally { await lim.close(); }
});

test('建立群組有頻率限制', async () => {
  const lim = await startBackend({ limits: { create: { max: 2, windowMs: 3600e3 } } });
  try {
    await lim.newGroup();
    await lim.newGroup();
    const r = await lim.call('POST', '/api/groups', { body: { createCode: 'test-create-code', name: 'x', memberName: 'a', emoji: '😎' } });
    assert.equal(r.status, 429);
  } finally { await lim.close(); }
});

test('CORS：只允許 GitHub Pages 與 localhost', async () => {
  const origin = (o, extra = {}) => s.call('GET', '/api/health', { headers: { Origin: o, ...extra } });
  for (const ok of ['https://ronchc.github.io', 'http://localhost:5173', 'http://localhost']) {
    const r = await origin(ok);
    assert.equal(r.status, 200, ok);
    assert.equal(r.headers.get('access-control-allow-origin'), ok);
  }
  for (const bad of ['https://evil.example.com', 'http://localhost.evil.com', 'https://ronchc.github.io.evil.com', 'http://127.0.0.1:5173', 'https://ronchc.github.io:8443']) {
    const r = await origin(bad);
    assert.equal(r.status, 403, bad);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
  // 預檢
  const pre = await s.call('OPTIONS', '/api/proxy/anthropic/v1/messages', {
    headers: { Origin: 'https://ronchc.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-api-key,anthropic-version,anthropic-beta,content-type,x-stainless-os' },
  });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /x-api-key/);
  assert.match(pre.headers.get('access-control-allow-methods'), /PUT/);
  assert.equal((await s.call('OPTIONS', '/api/state', { headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET' } })).status, 403);
});

test('資料太大、不是 JSON、不存在的路徑', async () => {
  const g = await s.newGroup();
  assert.equal((await s.call('POST', '/api/location', { token: g.token, raw: 'not json', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await s.call('POST', '/api/location', { token: g.token, raw: JSON.stringify({ x: 'a'.repeat(70000) }), headers: { 'Content-Type': 'application/json' } })).status, 413);
  assert.equal((await s.call('GET', '/api/nope', { token: g.token })).status, 404);
  assert.equal((await s.call('GET', '/etc/passwd')).status, 404);
  assert.equal((await s.call('GET', '/api/health')).json.ok, true);
});
