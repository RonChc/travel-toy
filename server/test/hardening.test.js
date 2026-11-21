// HME-44 資安修正：M1 來源 IP、M2 Claude 代轉白名單、L2 找人冷卻、L3 踢人換邀請碼、L4 暗號長度、L6 CORS
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startBackend, CREATE_CODE, CLAUDE_KEY } from './helpers.js';
import { buildConfig, parseTrustProxy } from '../src/config.js';
import { createApp, clientIpOf, ipKey } from '../src/app.js';
import { createLimiter } from '../src/ratelimit.js';
import { safeEqual } from '../src/crypto.js';

const wrongCreate = (s, headers = {}) => s.call('POST', '/api/groups', {
  body: { createCode: `wrong-${Math.random()}`, name: 'x', memberName: 'a', emoji: '😎' }, headers,
});

// ======================================================= M1 來源 IP =======================================================
test('M1 預設（不信任何標頭）：每次換假的 CF-Connecting-IP／X-Forwarded-For，第 6 次猜錯暗號照樣 429', async () => {
  const s = await startBackend({ limits: { create: { max: 5, windowMs: 3600e3 } } }); // trustProxy 預設 none
  try {
    for (let i = 1; i <= 5; i++) {
      const r = await wrongCreate(s, { 'CF-Connecting-IP': `203.0.113.${i}`, 'X-Forwarded-For': `198.51.100.${i}, 192.0.2.${i}` });
      assert.equal(r.status, 403, `第 ${i} 次`);
    }
    const sixth = await wrongCreate(s, { 'CF-Connecting-IP': '203.0.113.99', 'X-Forwarded-For': '198.51.100.99' });
    assert.equal(sixth.status, 429, '假標頭不能繞過鎖定');
    // 猜對也一樣被鎖（否則擋不住暴力猜測）
    const right = await s.call('POST', '/api/groups', { body: { createCode: CREATE_CODE, name: 'x', memberName: 'a', emoji: '😎' }, headers: { 'CF-Connecting-IP': '203.0.113.200' } });
    assert.equal(right.status, 429);
  } finally { await s.close(); }
});

test('M1 猜錯權杖（authFail）同樣不吃假標頭', async () => {
  const s = await startBackend({ limits: { authFail: { max: 3, windowMs: 60e3 } } });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await s.call('GET', '/api/state', { token: `${'x'.repeat(30)}${i}`, headers: { 'X-Forwarded-For': `10.0.0.${i}`, 'CF-Connecting-IP': `10.1.0.${i}` } });
      assert.equal(r.status, 401);
    }
    const r = await s.call('GET', '/api/state', { token: 'y'.repeat(31), headers: { 'X-Forwarded-For': '10.0.9.9', 'CF-Connecting-IP': '10.1.9.9' } });
    assert.equal(r.status, 429);
  } finally { await s.close(); }
});

test('M1 cloudflare 模式：只信 CF-Connecting-IP（假 X-Forwarded-For 沒用），不同真實來源各自計算', async () => {
  const s = await startBackend({ trustProxy: 'cloudflare', limits: { create: { max: 5, windowMs: 3600e3 } } });
  try {
    for (let i = 1; i <= 5; i++) {
      assert.equal((await wrongCreate(s, { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': `1.1.1.${i}` })).status, 403);
    }
    assert.equal((await wrongCreate(s, { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '9.9.9.9' })).status, 429, '同一個 CF IP 被鎖');
    // 另一個真實來源（另一個人）不受影響：一個人亂試不會鎖死所有人
    assert.equal((await wrongCreate(s, { 'CF-Connecting-IP': '203.0.113.8' })).status, 403);
    const ok = await s.call('POST', '/api/groups', { body: { createCode: CREATE_CODE, name: 'x', memberName: 'a', emoji: '😎' }, headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    assert.equal(ok.status, 201, '別人照樣能建立群組');
  } finally { await s.close(); }
});

test('M1 tailscale 模式：只取 X-Forwarded-For 最右邊（使用者自己塞在左邊的假 IP 沒用）', async () => {
  const s = await startBackend({ trustProxy: 'tailscale', limits: { create: { max: 5, windowMs: 3600e3 } } });
  try {
    for (let i = 1; i <= 5; i++) {
      // 通道把真正來源 203.0.113.7 附加在最右邊；左邊是使用者自己亂塞的
      assert.equal((await wrongCreate(s, { 'X-Forwarded-For': `fake-${i}, 8.8.8.${i}, 203.0.113.7`, 'CF-Connecting-IP': `4.4.4.${i}` })).status, 403);
    }
    assert.equal((await wrongCreate(s, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.7' })).status, 429);
    assert.equal((await wrongCreate(s, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.8' })).status, 403, '最右邊不同＝另一個來源');
  } finally { await s.close(); }
});

test('M1 clientIpOf：標頭格式不對或沒有時，退回連線本身的 IP；IPv6 只看 /64', () => {
  const req = (headers, remote = '127.0.0.1') => ({ headers, socket: { remoteAddress: remote } });
  assert.equal(clientIpOf(req({ 'cf-connecting-ip': '203.0.113.5' }, '127.0.0.1'), 'none'), '127.0.0.1');
  assert.equal(clientIpOf(req({ 'cf-connecting-ip': '203.0.113.5' }), 'cloudflare'), '203.0.113.5');
  assert.equal(clientIpOf(req({ 'cf-connecting-ip': 'not-an-ip' }), 'cloudflare'), '127.0.0.1');
  assert.equal(clientIpOf(req({}), 'cloudflare'), '127.0.0.1');
  assert.equal(clientIpOf(req({ 'x-forwarded-for': '1.1.1.1, evil' }), 'tailscale'), '127.0.0.1', '最右邊不是 IP 就不信');
  assert.equal(clientIpOf(req({ 'x-forwarded-for': '1.1.1.1, 100.64.0.5' }), 'tailscale'), '100.64.0.5');
  assert.equal(clientIpOf(req({ 'x-forwarded-for': '1.1.1.1' }), 'cloudflare'), '127.0.0.1', 'cloudflare 模式不看 XFF');
  assert.equal(clientIpOf(req({}, '::ffff:10.0.0.1'), 'none'), '10.0.0.1');
  const a = clientIpOf(req({ 'cf-connecting-ip': '2001:db8:1:2:aaaa::1' }), 'cloudflare');
  const b = clientIpOf(req({ 'cf-connecting-ip': '2001:db8:1:2:bbbb:cccc:dddd:eeee' }), 'cloudflare');
  assert.equal(a, b, '同一個 /64 視為同一個人');
  assert.notEqual(a, clientIpOf(req({ 'cf-connecting-ip': '2001:db8:1:3::1' }), 'cloudflare'));
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
});

test('M1 TRUST_PROXY 只認 none／cloudflare／tailscale，舊的 1 與亂寫都拒絕啟動', () => {
  assert.equal(parseTrustProxy(''), 'none');
  assert.equal(parseTrustProxy('0'), 'none');
  assert.equal(parseTrustProxy('Cloudflare'), 'cloudflare');
  assert.equal(parseTrustProxy('tailscale'), 'tailscale');
  assert.throws(() => parseTrustProxy('1'), /TRUST_PROXY/);
  assert.throws(() => parseTrustProxy('yes'), /TRUST_PROXY/);
  assert.throws(() => buildConfig({ TRUST_PROXY: '1' }), /TRUST_PROXY/);
});

test('M1 限速表有筆數上限：灌大量不同來源也不會無限長大，且丟的是最舊的', () => {
  let t = 1000;
  const lim = createLimiter(() => t, { maxEntries: 50 });
  const cfg = { max: 3, windowMs: 3600e3 };
  for (let i = 0; i < 500; i++) lim.hit('authFail', `ip-${i}`, cfg);
  assert.ok(lim.size() <= 50, `筆數 ${lim.size()} 應不超過 50`);
  // 最新的還在（再打 3 次就會超過）
  for (let i = 0; i < 3; i++) lim.hit('authFail', 'ip-499', cfg);
  assert.equal(lim.hit('authFail', 'ip-499', cfg).ok, false);
  // 預設上限是 10 萬
  assert.equal(createLimiter().size(), 0);
});

test('M1 limiter：cost 與 peek', () => {
  const lim = createLimiter(() => 0);
  const cfg = { max: 5, windowMs: 1000 };
  assert.equal(lim.peek('b', 'k', cfg, 5), true);
  assert.equal(lim.hit('b', 'k', cfg, 4).ok, true);
  assert.equal(lim.peek('b', 'k', cfg, 2), false);
  assert.equal(lim.peek('b', 'k', cfg, 1), true);
  assert.equal(lim.hit('b', 'k', cfg, 2).ok, false);
});

// ======================================================= M2 Claude 代轉 =======================================================
const OK_BODY = () => ({ model: 'claude-haiku-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });

async function familySetup(s) {
  const g = await s.newGroup();
  s.upstream.calls.length = 0;
  return g.token; // 管理員＝家人
}
const claudeRaw = (s, token, raw, headers = {}, path = '/api/proxy/anthropic/v1/messages') =>
  s.call('POST', path, { token, raw, headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...headers } });
const claude = (s, token, body, headers = {}, path) => claudeRaw(s, token, JSON.stringify(body), headers, path);
const lastUpstream = (s) => s.upstream.calls.at(-1);

test('M2 mcp_servers／container／service_tier 一律拒絕，且不會送到上游', async () => {
  const s = await startBackend();
  try {
    const t = await familySetup(s);
    for (const extra of [
      { mcp_servers: [{ type: 'url', url: 'https://evil.example/mcp', name: 'x' }] },
      { container: { id: 'abc' } },
      { service_tier: 'priority' },
    ]) {
      const r = await claude(s, t, { ...OK_BODY(), ...extra });
      assert.equal(r.status, 400, JSON.stringify(Object.keys(extra)));
      assert.equal(r.json.error, 'field_not_allowed');
    }
    assert.equal(s.upstream.calls.length, 0);
  } finally { await s.close(); }
});

test('M2 內建工具（web_search／code_execution／bash 等）被拒；App 自己的自訂工具照常通過', async () => {
  const s = await startBackend();
  try {
    const t = await familySetup(s);
    for (const tool of [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 50 },
      { type: 'code_execution_20250522', name: 'code_execution' },
      { type: 'bash_20250124', name: 'bash' },
      { type: 'text_editor_20250124', name: 'str_replace_editor' },
      { type: 'mcp_toolset', mcp_server_name: 'x' },
    ]) {
      const r = await claude(s, t, { ...OK_BODY(), tools: [tool] });
      assert.equal(r.status, 400, tool.type);
      assert.equal(r.json.error, 'tool_type_not_allowed');
    }
    assert.equal(s.upstream.calls.length, 0);

    // App 的 search_places 工具（有 strict、eager_input_streaming）
    const custom = { name: 'search_places', description: '搜尋', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, strict: true, eager_input_streaming: true, evil_field: 1 };
    const ok = await claude(s, t, { ...OK_BODY(), tools: [custom, { ...custom, type: 'custom', name: 'other' }] });
    assert.equal(ok.status, 200);
    const sent = JSON.parse(lastUpstream(s).body);
    assert.equal(sent.tools.length, 2);
    assert.equal(sent.tools[0].strict, true);
    assert.equal(sent.tools[0].eager_input_streaming, true);
    assert.ok(!('evil_field' in sent.tools[0]), '工具上多餘的欄位被剝除');
    assert.ok(!('type' in sent.tools[1]) || sent.tools[1].type === undefined);
  } finally { await s.close(); }
});

test('M2 anthropic-beta 白名單：未知的值被剝除，白名單內的保留', async () => {
  const s = await startBackend();
  try {
    const t = await familySetup(s);
    await claude(s, t, OK_BODY(), { 'anthropic-beta': 'code-execution-2025-05-22,mcp-client-2025-04-04' });
    assert.equal(lastUpstream(s).headers['anthropic-beta'], undefined, '全是未知的 beta＝不送這個標頭');
    await claude(s, t, OK_BODY(), { 'anthropic-beta': 'files-api-2025-04-14, server-side-fallback-2026-07-01 ,context-1m-2025-08-07' });
    assert.equal(lastUpstream(s).headers['anthropic-beta'], 'server-side-fallback-2026-07-01', '只留白名單內的');
    await claude(s, t, OK_BODY(), { 'anthropic-beta': 'x'.repeat(10) });
    assert.equal(lastUpstream(s).headers['anthropic-beta'], undefined);
    // 白名單可由 .env 調整
    const s2 = await startBackend({ anthropicBetas: ['my-beta-1'] });
    try {
      const t2 = await familySetup(s2);
      await claude(s2, t2, OK_BODY(), { 'anthropic-beta': 'server-side-fallback-2026-07-01,my-beta-1' });
      assert.equal(lastUpstream(s2).headers['anthropic-beta'], 'my-beta-1');
    } finally { await s2.close(); }
  } finally { await s.close(); }
});

test('M2 max_tokens 必填、必須是整數、不得超過上限（預設 16000）', async () => {
  const s = await startBackend();
  try {
    const t = await familySetup(s);
    const withTokens = (v) => { const b = OK_BODY(); if (v === undefined) delete b.max_tokens; else b.max_tokens = v; return b; };
    for (const bad of [undefined, 16001, 64000, 1e9, 0, -5, 10.5, '100', null]) {
      const r = await claude(s, t, withTokens(bad));
      assert.equal(r.status, 400, `max_tokens=${bad}`);
    }
    assert.equal(s.upstream.calls.length, 0);
    assert.equal((await claude(s, t, withTokens(16000))).status, 200, '剛好等於上限可以');
    assert.equal((await claude(s, t, withTokens(1))).status, 200);
    // 上限可由 .env 調整
    const s2 = await startBackend({ claudeMaxTokens: 8000 });
    try {
      const t2 = await familySetup(s2);
      assert.equal((await claude(s2, t2, withTokens(8001))).status, 400);
      assert.equal((await claude(s2, t2, withTokens(8000))).status, 200);
    } finally { await s2.close(); }
  } finally { await s.close(); }
});

test('M2 重複的 model 鍵不能繞過白名單：上游收到的是重組後的單一 model', async () => {
  const s = await startBackend();
  try {
    const t = await familySetup(s);
    const dupBad = '{"model":"claude-haiku-5-5","model":"evil-expensive-model","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}';
    assert.equal((await claudeRaw(s, t, dupBad)).status, 403, '最後一個 model 不在白名單 → 拒絕');
    assert.equal(s.upstream.calls.length, 0);
    const dupOk = '{"model":"evil-expensive-model","model":"claude-haiku-5-5","max_tokens":10,"max_tokens":20,"messages":[{"role":"user","content":"hi"}]}';
    assert.equal((await claudeRaw(s, t, dupOk)).status, 200);
    const body = lastUpstream(s).body;
    assert.equal(body.split('"model"').length - 1, 1, '上游只會看到一個 model 鍵');
    assert.ok(!body.includes('evil-expensive-model'));
    assert.equal(JSON.parse(body).max_tokens, 20);
  } finally { await s.close(); }
});

test('M2 送上游的是重組後的白名單欄位：多餘欄位、未知頂層欄位都不會穿過去', async () => {
  const s = await startBackend();
  try {
    const t = await familySetup(s);
    const r = await claude(s, t, {
      ...OK_BODY(), temperature: 0.5, stream: false, system: '你是助理',
      metadata: { user_id: 'x' }, thinking: { type: 'enabled', budget_tokens: 5000 }, top_k: 3, betas: ['x'], unknown_field: { a: 1 },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } }, task_budget: 99999 },
      fallbacks: 'default',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], extra: 1 }, { role: 'assistant', content: 'ok', foo: 1 }],
    });
    assert.equal(r.status, 200);
    const sent = JSON.parse(lastUpstream(s).body);
    assert.deepEqual(Object.keys(sent).sort(), ['fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'stream', 'system', 'temperature']);
    assert.deepEqual(sent.output_config, { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } });
    assert.deepEqual(sent.messages[1], { role: 'assistant', content: 'ok' });
    assert.equal(sent.messages[0].extra, undefined);
  } finally { await s.close(); }
});

test('M2 內容區塊與 fallbacks 檢查：只放行文字／工具呼叫／工具結果；不能自己指定備用模型', async () => {
  const s = await startBackend();
  try {
    const t = await familySetup(s);
    const withMsgs = (content) => ({ ...OK_BODY(), messages: [{ role: 'user', content }] });
    for (const content of [
      [{ type: 'document', source: { type: 'url', url: 'https://evil.example/x.pdf' } }],
      [{ type: 'image', source: { type: 'url', url: 'https://evil.example/x.png' } }],
      [{ type: 'server_tool_use', id: 'x', name: 'web_search', input: {} }],
      [{ type: 'mcp_tool_use', id: 'x', name: 'y', server_name: 'z', input: {} }],
      [{ type: 'container_upload', file_id: 'f' }],
      [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'image', source: {} }] }],

    ]) {
      const r = await claude(s, t, withMsgs(content));
      assert.equal(r.status, 400, JSON.stringify(content).slice(0, 60));
      assert.equal(r.json.error, 'block_type_not_allowed');
    }
    // App 實際會送的：文字、工具呼叫、工具結果（字串或文字區塊）
    const okMsgs = { ...OK_BODY(), messages: [
      { role: 'user', content: '排行程' },
      { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool_use', id: 'tu1', name: 'search_places', input: { query: 'a', near: '' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '[]' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'search_places', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: 'x' }] }] },
    ] };
    assert.equal((await claude(s, t, okMsgs)).status, 200);
    // fallbacks
    for (const fb of [['claude-opus-5-5'], { model: 'x' }, 'claude-opus-5-5', true]) {
      assert.equal((await claude(s, t, { ...OK_BODY(), fallbacks: fb })).status, 400);
    }
    // 其他基本檢查
    for (const bad of [{ messages: [] }, { messages: 'x' }, { messages: [{ role: 'system', content: 'x' }] }, { stream: 'yes' }, { temperature: 5 }, { tools: 'x' }, { tool_choice: { type: 'evil' } }, { system: [{ type: 'image' }] }]) {
      assert.equal((await claude(s, t, { ...OK_BODY(), ...bad })).status, 400, JSON.stringify(bad));
    }
  } finally { await s.close(); }
});

test('M2 Opus 另設較低的每日次數（也計入總次數）；其他模型不受影響', async () => {
  const s = await startBackend({ claudeDailyLimit: 4, claudeOpusDailyLimit: 2 });
  try {
    const t = await familySetup(s);
    const opus = () => claude(s, t, { ...OK_BODY(), model: 'claude-opus-5-5' });
    const haiku = () => claude(s, t, OK_BODY());
    assert.equal((await opus()).status, 200);
    assert.equal((await opus()).status, 200);
    const over = await opus();
    assert.equal(over.status, 429);
    assert.equal(over.json.error, 'daily_limit');
    assert.match(over.json.message, /Opus/);
    const n = s.upstream.calls.length;
    assert.equal((await haiku()).status, 200, 'Haiku 還能用');
    assert.equal((await haiku()).status, 200);
    assert.equal((await haiku()).status, 429, '總次數 4 次用完（Opus 2 次也算在內）');
    assert.equal(s.upstream.calls.length, n + 2);
    s.clock.t += 24 * 3600e3;
    assert.equal((await opus()).status, 200, '隔天重置');
  } finally { await s.close(); }
});

test('M2 App 實際送出的三種請求形狀（挑店／招牌整理／行程串流）都能通過，且內容原樣送到上游', async () => {
  const s = await startBackend();
  try {
    const t = await familySetup(s);
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
    const shapes = [
      // recommend（beta.messages.create）
      { model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default', output_config: { effort: 'low', format: { type: 'json_schema', schema } }, system: 's', messages: [{ role: 'user', content: 'u' }] },
      // highlights（messages.create）
      { model: 'claude-haiku-5-5', max_tokens: 8000, output_config: { effort: 'low', format: { type: 'json_schema', schema } }, system: 's', messages: [{ role: 'user', content: 'u' }] },
      // planTrip（beta.messages.stream）
      { model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default', output_config: { effort: 'medium' }, system: 's', stream: true,
        tools: [{ name: 'search_places', description: 'd', input_schema: { type: 'object', properties: {}, additionalProperties: false }, strict: true, eager_input_streaming: true }], messages: [{ role: 'user', content: 'u' }] },
    ];
    for (const b of shapes) {
      const r = await claude(s, t, b, { 'anthropic-beta': 'server-side-fallback-2026-07-01' });
      assert.equal(r.status, 200, JSON.stringify(Object.keys(b)));
      assert.deepEqual(JSON.parse(lastUpstream(s).body), b, '上游收到的內容與 App 送的一致');
    }
  } finally { await s.close(); }
});

// ======================================================= L2 找人冷卻 =======================================================
test('L2 同一對（發問者→目標）60 秒內不能再問；換人、過了冷卻、反方向都可以', async () => {
  const s = await startBackend({ limits: { findPair: { max: 1, windowMs: 60e3 } } });
  try {
    const g = await s.newGroup();
    const b = await s.join(g.inviteCode, 'B');
    const c = await s.join(g.inviteCode, 'C');
    const find = (token, targetId) => s.call('POST', '/api/find', { token, body: { targetId } });
    assert.equal((await find(g.token, b.memberId)).status, 201);
    const again = await find(g.token, b.memberId);
    assert.equal(again.status, 429);
    assert.equal(again.json.error, 'find_cooldown');
    assert.equal((await find(g.token, c.memberId)).status, 201, '換一個人可以');
    assert.equal((await find(b.token, g.memberId)).status, 201, '反方向另外算');
    s.clock.t += 59e3;
    assert.equal((await find(g.token, b.memberId)).status, 429, '59 秒還在冷卻');
    s.clock.t += 2e3;
    assert.equal((await find(g.token, b.memberId)).status, 201, '過 60 秒可以再問');
  } finally { await s.close(); }
});

test('L2 冷卻中不會再推播；一次問全部時冷卻中的人被略過', async () => {
  const s = await startBackend({ limits: { findPair: { max: 1, windowMs: 60e3 } } });
  try {
    const g = await s.newGroup();
    const b = await s.join(g.inviteCode, 'B');
    const c = await s.join(g.inviteCode, 'C');
    await s.subscribe(b.token, 'b');
    await s.subscribe(c.token, 'c');
    assert.equal((await s.call('POST', '/api/find', { token: g.token, body: { targetId: b.memberId } })).status, 201);
    const pushesBefore = s.pushes.length;
    assert.equal((await s.call('POST', '/api/find', { token: g.token, body: { targetId: b.memberId } })).status, 429);
    assert.equal(s.pushes.length, pushesBefore, '冷卻中不推播');
    const all = await s.call('POST', '/api/find', { token: g.token, body: { all: true } });
    assert.equal(all.status, 201);
    assert.equal(all.json.finds.length, 1, '只問沒在冷卻的 C');
    assert.equal(all.json.finds[0].targetId, c.memberId);
    assert.deepEqual(all.json.skipped, [b.memberId]);
    assert.equal(s.pushes.length, pushesBefore + 1);
    assert.equal((await s.call('POST', '/api/find', { token: g.token, body: { all: true } })).status, 429, '全部都在冷卻就回 429');
  } finally { await s.close(); }
});

test('L2 一次問全部依人數計入額度（問 3 個人＝3 次）', async () => {
  const s = await startBackend({ limits: { find: { max: 5, windowMs: 60e3 } } });
  try {
    const g = await s.newGroup();
    for (const n of ['B', 'C', 'D']) await s.join(g.inviteCode, n);
    const all = () => s.call('POST', '/api/find', { token: g.token, body: { all: true } });
    assert.equal((await all()).status, 201); // 用掉 3
    assert.equal((await all()).status, 429, '再問全部要 3 次，3+3 超過 5');
    s.clock.t += 61e3;
    assert.equal((await all()).status, 201, '視窗過了恢復');
  } finally { await s.close(); }
});

// ======================================================= L3 踢人換邀請碼 =======================================================
test('L3 踢人後自動重發邀請碼：舊邀請碼失效、回傳的新碼可用', async () => {
  const s = await startBackend();
  try {
    const g = await s.newGroup();
    const b = await s.join(g.inviteCode, 'B');
    const kicked = await s.call('DELETE', `/api/members/${b.memberId}`, { token: g.token });
    assert.equal(kicked.status, 200);
    assert.ok(kicked.json.inviteCode && kicked.json.inviteCode !== g.inviteCode);
    const old = await s.call('POST', '/api/join', { body: { inviteCode: g.inviteCode, name: 'B2', emoji: '🐶' } });
    assert.equal(old.status, 404, '被踢的人拿舊邀請碼加不回來');
    const fresh = await s.call('POST', '/api/join', { body: { inviteCode: kicked.json.inviteCode, name: 'D', emoji: '🐶' } });
    assert.equal(fresh.status, 201);
  } finally { await s.close(); }
});

// ======================================================= L4 暗號 =======================================================
test('L4 建立暗號少於 12 字就拒絕啟動；空白（沒人能建群組）與 12 字以上可以', () => {
  const mk = (createCode) => createApp({ config: buildConfig({}, { createCode, dbFile: ':memory:', dataDir: 'unused' }) });
  assert.throws(() => mk('short'), /GROUP_CREATE_CODE.*12/);
  assert.throws(() => mk('a'.repeat(11)), /12/);
  mk('a'.repeat(12)).close();
  mk('').close();
});

test('L4 safeEqual：不同長度也不會丟錯、結果正確（兩邊先 sha256 再 timingSafeEqual）', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', 'x'), false);
  assert.equal(safeEqual('你好你好你好', '你好你好你好'), true);
  assert.equal(safeEqual('a'.repeat(5000), 'a'.repeat(5001)), false);
});

// ======================================================= L6 CORS =======================================================
test('L6 CORS：http://localhost 只在 DEV=1 才允許；GitHub Pages 與 EXTRA_ORIGINS 不受影響', async () => {
  const prod = await startBackend({ dev: false, extraOrigins: ['https://family.example.com'] });
  try {
    const origin = (o) => prod.call('GET', '/api/health', { headers: { Origin: o } });
    for (const bad of ['http://localhost:5173', 'http://localhost']) assert.equal((await origin(bad)).status, 403, bad);
    for (const ok of ['https://ronchc.github.io', 'https://family.example.com']) assert.equal((await origin(ok)).status, 200, ok);
  } finally { await prod.close(); }
  const dev = await startBackend({ dev: true });
  try {
    assert.equal((await dev.call('GET', '/api/health', { headers: { Origin: 'http://localhost:5173' } })).status, 200);
    assert.equal((await dev.call('GET', '/api/health', { headers: { Origin: 'http://localhost.evil.com' } })).status, 403);
  } finally { await dev.close(); }
  assert.equal(buildConfig({}).dev, false, '預設不是開發模式');
  assert.equal(buildConfig({ DEV: '1' }).dev, true);
});

// 這支測試確認：上游真的回傳錯誤或慢時，Claude 金鑰不會漏
test('M2 上游回應若夾帶 Claude 金鑰也會被遮掉（重組後的路徑一樣有遮）', async () => {
  const s = await startBackend();
  try {
    const srv = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ leak: req.headers['x-api-key'] })); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    s.config.anthropicBase = `http://127.0.0.1:${srv.address().port}`;
    const t = await familySetup(s);
    const r = await claude(s, t, OK_BODY());
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(CLAUDE_KEY));
    srv.close();
  } finally { await s.close(); }
});

// ======================================================= L1 前端網址檢查 =======================================================
test('L1 safeHttpsUrl：只放行 https，其餘（javascript:、data:、http:、亂字串）一律回空字串', async () => {
  const { safeHttpsUrl } = await import('../../js/safeurl.js');
  assert.equal(safeHttpsUrl('https://maps.google.com/?cid=1'), 'https://maps.google.com/?cid=1');
  assert.equal(safeHttpsUrl('HTTPS://Maps.Google.com/a b'), 'https://maps.google.com/a%20b');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://maps.google.com/', 'vbscript:x', 'file:///etc/passwd', '//evil.example/x', 'maps.google.com', '', null, undefined, 123, {}]) {
    assert.equal(safeHttpsUrl(bad), '', String(bad));
  }
});
