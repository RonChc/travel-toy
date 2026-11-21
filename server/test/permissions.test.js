// 驗收 2：家人／朋友權限與金鑰代轉
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBackend, GOOGLE_KEY, CLAUDE_KEY } from './helpers.js';

let s;
before(async () => { s = await startBackend({ claudeDailyLimit: 3, googleDailyLimit: 4 }); });
after(async () => { await s.close(); });

const searchNearby = (token, body = { includedTypes: ['park'] }) => s.call('POST', '/api/proxy/google/places/searchNearby', {
  token, body, headers: { 'X-Goog-FieldMask': 'places.id,places.displayName' },
});
const claude = (token, body = { model: 'claude-haiku-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, path = '/api/proxy/anthropic/v1/messages') =>
  s.call('POST', path, { token, body, headers: { 'anthropic-version': '2023-06-01' } });

async function setup() {
  const g = await s.newGroup();
  const b = await s.join(g.inviteCode, 'Bob');
  return { g, b };
}

test('朋友呼叫代轉被拒（403），家人可以；改回朋友馬上又被拒', async () => {
  const { g, b } = await setup();
  s.upstream.calls.length = 0;

  const r1 = await searchNearby(b.token);
  assert.equal(r1.status, 403);
  assert.equal(r1.json.error, 'friend_no_proxy');
  assert.equal(s.upstream.calls.length, 0, '朋友的請求不能到達上游');
  assert.equal((await claude(b.token)).status, 403);

  assert.equal((await s.call('PATCH', `/api/members/${b.memberId}`, { token: g.token, body: { tier: 'family' } })).status, 200);
  const r2 = await searchNearby(b.token);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.places[0].displayName.text, '假店家');
  assert.equal((await claude(b.token)).status, 200);

  assert.equal((await s.call('PATCH', `/api/members/${b.memberId}`, { token: g.token, body: { tier: 'friend' } })).status, 200);
  assert.equal((await searchNearby(b.token)).status, 403, '改回朋友後馬上被拒');
  assert.equal((await claude(b.token)).status, 403);
});

test('踢掉家人後，權杖馬上失效（401）', async () => {
  const { g, b } = await setup();
  await s.call('PATCH', `/api/members/${b.memberId}`, { token: g.token, body: { tier: 'family' } });
  assert.equal((await searchNearby(b.token)).status, 200);
  await s.call('DELETE', `/api/members/${b.memberId}`, { token: g.token });
  assert.equal((await searchNearby(b.token)).status, 401);
});

test('後台代呼叫時才帶金鑰與 Referer，回應與狀態裡看不到金鑰', async () => {
  const { g, b } = await setup();
  await s.call('PATCH', `/api/members/${b.memberId}`, { token: g.token, body: { tier: 'family' } });
  s.upstream.calls.length = 0;

  const r = await searchNearby(b.token, { includedTypes: ['park'], note: 'x' });
  const call = s.upstream.calls.at(-1);
  assert.equal(call.url, '/v1/places:searchNearby');
  assert.equal(call.headers['x-goog-api-key'], GOOGLE_KEY, '後台帶老闆的金鑰去呼叫 Google');
  assert.equal(call.headers.referer, 'https://ronchc.github.io/');
  assert.equal(call.headers['x-goog-fieldmask'], 'places.id,places.displayName');
  assert.ok(!call.headers.authorization, '成員權杖不能被轉給上游');

  const c = await claude(b.token);
  const cc = s.upstream.calls.at(-1);
  assert.equal(cc.url, '/v1/messages');
  assert.equal(cc.headers['x-api-key'], CLAUDE_KEY);

  // 給家人的所有回應（含標頭）都不含金鑰
  const state = await s.call('GET', '/api/state', { token: b.token });
  for (const resp of [r, c, state]) {
    const all = resp.text + JSON.stringify([...resp.headers]);
    assert.ok(!all.includes(GOOGLE_KEY) && !all.includes(CLAUDE_KEY) && !all.includes('AIza') && !all.includes('sk-ant'), '回應不可含金鑰');
  }
});

test('上游回應若意外夾帶金鑰，也會被遮掉', async () => {
  const echo = await startBackend({ googleBase: '' });
  try {
    // 用另一個假上游：把收到的金鑰回傳出來
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ leak: req.headers['x-goog-api-key'] })); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    echo.config.googleBase = `http://127.0.0.1:${srv.address().port}`;
    const g = await echo.newGroup();
    const r = await echo.call('POST', '/api/proxy/google/places/searchText', { token: g.token, body: { textQuery: 'x' }, headers: { 'X-Goog-FieldMask': 'places.id' } });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(GOOGLE_KEY));
    srv.close();
  } finally { await echo.close(); }
});

test('只轉送 App 用到的路徑，其他一律拒絕', async () => {
  const { g } = await setup(); // g.token 是管理員（家人）
  const call = (path, extra = {}) => s.call('POST', path, { token: g.token, body: {}, headers: { 'X-Goog-FieldMask': 'places.id' }, ...extra });
  for (const p of [
    '/api/proxy/google/places/details', '/api/proxy/google/places/searchNearby/../x', '/api/proxy/google/geocode',
    '/api/proxy/anthropic/v1/models', '/api/proxy/anthropic/v1/messages/batches', '/api/proxy/', '/api/proxy/anthropic/v1/complete',
  ]) {
    const r = await call(p);
    assert.equal(r.status, 403, `${p} 應被拒絕，實際 ${r.status}`);
  }
  const before = s.upstream.calls.length;
  // 方法不對
  assert.equal((await s.call('GET', '/api/proxy/google/places/searchText', { token: g.token })).status, 405);
  assert.equal(s.upstream.calls.length, before);
});

test('Claude：只允許指定模型、max_tokens 上限', async () => {
  const { g } = await setup();
  assert.equal((await claude(g.token, { model: 'some-other-model', max_tokens: 10, messages: [] })).status, 403);
  assert.equal((await claude(g.token, { model: 'claude-haiku-5-5', max_tokens: 999999, messages: [] })).status, 400);
  assert.equal((await claude(g.token, 'oops')).status, 400);
});

test('Claude 串流（AI 行程）能邊收邊轉，?beta=true 也行', async () => {
  const { g } = await setup();
  s.upstream.calls.length = 0;
  const r = await s.call('POST', '/api/proxy/anthropic/v1/messages?beta=true&evil=1', {
    token: g.token, body: { model: 'claude-opus-5-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' },
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  assert.match(r.text, /message_stop/);
  const c = s.upstream.calls.at(-1);
  assert.equal(c.url, '/v1/messages?beta=true', '只帶 beta 參數，其他查詢參數丟掉');
  assert.equal(c.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
});

test('每人每天呼叫次數上限（Claude 預設可調、獨立計算）', async () => {
  const { g, b } = await setup();
  await s.call('PATCH', `/api/members/${b.memberId}`, { token: g.token, body: { tier: 'family' } });
  for (let i = 0; i < 3; i++) assert.equal((await claude(b.token)).status, 200);
  const over = await claude(b.token);
  assert.equal(over.status, 429);
  assert.equal(over.json.error, 'daily_limit');
  assert.equal((await claude(g.token)).status, 200, '別人的額度不受影響');
  assert.equal((await searchNearby(b.token)).status, 200, 'Google 額度另外算');
  // 隔天重置
  s.clock.t += 24 * 3600e3;
  assert.equal((await claude(b.token)).status, 200);
});

test('後台沒設定金鑰時回 503，不會把空金鑰送出去', async () => {
  const nokey = await startBackend({ googleApiKey: '', anthropicApiKey: '' });
  try {
    const g = await nokey.newGroup();
    const r = await nokey.call('POST', '/api/proxy/google/places/searchText', { token: g.token, body: {}, headers: { 'X-Goog-FieldMask': 'places.id' } });
    assert.equal(r.status, 503);
    assert.equal(nokey.upstream.calls.length, 0);
  } finally { await nokey.close(); }
});

test('沒帶權杖、亂寫權杖，一律 401', async () => {
  assert.equal((await s.call('POST', '/api/proxy/google/places/searchText', { body: {}, headers: { 'X-Goog-FieldMask': 'places.id' } })).status, 401);
  assert.equal((await s.call('POST', '/api/proxy/anthropic/v1/messages', { token: 'x'.repeat(43), body: {} })).status, 401);
  // Claude SDK 把權杖放在 x-api-key
  const { g } = await setup();
  const viaApiKey = await s.call('POST', '/api/proxy/anthropic/v1/messages', {
    body: { model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, headers: { 'x-api-key': g.token },
  });
  assert.equal(viaApiKey.status, 200);
});
