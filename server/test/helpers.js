// 測試共用：起一個真的後台（隨機埠、暫存資料夾、記憶體資料庫）＋假的 Google／Claude 上游＋假推播
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

export const GOOGLE_KEY = 'AIzaSy-TEST-GOOGLE-KEY-0123456789';
export const CLAUDE_KEY = 'sk-ant-TEST-CLAUDE-KEY-0123456789';
export const CREATE_CODE = 'test-create-code';
export const PUSH_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-endpoint-';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// 假上游：記錄收到的請求，回固定內容
export async function startUpstream() {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url.startsWith('/v1/messages')) {
      let json = {};
      try { json = JSON.parse(body); } catch { /* 略過 */ }
      if (json.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // 給 App 的「AI 幫我挑」一個合法的結構化回覆
      const text = JSON.stringify({ summary: '假 AI：推薦假店家', picks: [{ id: 'p1', reason: '測試用理由' }], tips: '' });
      return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
    }
    if (req.url.includes('computeRouteMatrix')) {
      let n = 1;
      try { n = JSON.parse(body).destinations.length; } catch { /* 略過 */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(Array.from({ length: n }, (_, i) => ({ originIndex: 0, destinationIndex: i, duration: `${300 + i * 60}s`, distanceMeters: 400 + i * 100, condition: 'ROUTE_EXISTS' }))));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ places: [{
      id: 'p1', displayName: { text: '假店家' }, location: { latitude: 25.0335, longitude: 121.5655 }, rating: 4.5, userRatingCount: 321,
      primaryType: 'park', primaryTypeDisplayName: { text: '公園' }, types: ['park'], googleMapsUri: 'https://maps.google.com/?cid=1', shortFormattedAddress: '測試路 1 號',
    }] }));
  });
  const port = await listen(server);
  return { port, calls, url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

export async function startBackend(overrides = {}) {
  const upstream = await startUpstream();
  const dataDir = mkdtempSync(join(tmpdir(), 'tt-group-'));
  const clock = { t: Date.UTC(2026, 10, 21, 4, 0, 0) };
  const pushes = [];
  const pushSender = async (sub, payload) => {
    if (sub.endpoint.includes('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    const rec = { endpoint: sub.endpoint, payload: JSON.parse(payload) };
    pushes.push(rec);
    ctx.onPush?.(rec);
  };
  const config = buildConfig({}, {
    dataDir, dbFile: ':memory:', createCode: CREATE_CODE,
    googleApiKey: GOOGLE_KEY, anthropicApiKey: CLAUDE_KEY,
    googleBase: upstream.url, anthropicBase: upstream.url,
    vapidPublic: 'x', vapidPrivate: 'y',
    // 一般測試不要被頻率限制擋住；要測頻率的測試自己覆寫
    limits: Object.fromEntries(['authFail', 'create', 'join', 'find', 'upload', 'proxy', 'location', 'general'].map((k) => [k, { max: 100000, windowMs: 60e3 }])),
    ...overrides,
  });
  const app = createApp({ config, now: () => clock.t, pushSender });
  const server = createServer(app.handler);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  // 簡單的 API 呼叫器：api(token).post('/api/x', body)
  const call = async (method, path, { token, body, raw, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* 不是 JSON */ }
    return { status: res.status, json, buf, headers: res.headers, text: buf.toString('utf8') };
  };

  const ctx = {
    onPush: null, // E2E 用：收到推播時的回呼
    base, app, upstream, clock, pushes, dataDir, config, call,
    photoFiles: () => readdirSync(join(dataDir, 'photos')),
    async newGroup(name = '週末出遊') {
      const r = await call('POST', '/api/groups', { body: { createCode: CREATE_CODE, name, memberName: '老闆', emoji: '😎' } });
      if (r.status !== 201) throw new Error(`建立群組失敗 ${r.status} ${r.text}`);
      return { ...r.json, admin: r.json.token };
    },
    async join(inviteCode, name = '小明', emoji = '🐶') {
      const r = await call('POST', '/api/join', { body: { inviteCode, name, emoji } });
      if (r.status !== 201) throw new Error(`加入失敗 ${r.status} ${r.text}`);
      return r.json;
    },
    async subscribe(token, id = 'a') {
      const sub = { endpoint: `${PUSH_ENDPOINT}${id}`, keys: { p256dh: 'BPxxxxxxxxxxxxxxxxxxxxxxxx', auth: 'authauthauth1234' } };
      return call('PUT', '/api/push', { token, body: { subscription: sub } });
    },
    async close() {
      server.close();
      upstream.close();
      app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return ctx;
}

// 一張最小的合法 JPEG／PNG／WebP 檔頭（測試用，不需要真的能顯示）
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0fake-image-bytes')]);
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-bytes')]);
export const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPfake-webp-bytes')]);
