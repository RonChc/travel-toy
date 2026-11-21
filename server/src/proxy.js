// 金鑰代轉：家人手機呼叫後台，後台帶著老闆的金鑰去呼叫 Google／Claude。
// 金鑰只在這個檔案轉送時使用，不會出現在任何回應裡。只轉送 App 實際用到的路徑與欄位。
//
// Claude 請求不會「原樣轉送」：後台先解析、驗證，再用白名單欄位重組一份新的請求才送出，
// 這樣家人手機（或拿到權杖的人）就不能夾帶 mcp_servers、內建工具（web_search、code_execution…）、
// 超大 max_tokens、未知 beta 之類的東西去花老闆的錢。
import { Readable } from 'node:stream';
import { HttpError } from './validate.js';

// 對外路徑 → 上游。其他路徑一律拒絕。
const GOOGLE_ROUTES = {
  '/api/proxy/google/places/searchNearby': { host: 'places', path: '/v1/places:searchNearby' },
  '/api/proxy/google/places/searchText': { host: 'places', path: '/v1/places:searchText' },
  '/api/proxy/google/routes/computeRouteMatrix': { host: 'routes', path: '/distanceMatrix/v2:computeRouteMatrix' },
  '/api/proxy/google/routes/computeRoutes': { host: 'routes', path: '/directions/v2:computeRoutes' },
};
const ANTHROPIC_PATH = '/api/proxy/anthropic/v1/messages';

const FIELD_MASK = /^[A-Za-z0-9_.,*]{1,3000}$/;
const VERSION = /^[0-9-]{1,20}$/;

export const isProxyPath = (path) => path.startsWith('/api/proxy/');

export function proxyKind(path) {
  if (GOOGLE_ROUTES[path]) return 'google';
  if (path === ANTHROPIC_PATH) return 'claude';
  return null;
}

const redact = (text, secrets) => secrets.filter(Boolean).reduce((t, s) => t.split(s).join('***'), text);

// ---------- Claude 請求：驗證並重組 ----------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (code, msg, status = 400) => new HttpError(status, code, msg);

// 明確拒絕（不是默默丟掉）：這些欄位一出現就代表有人想做 App 不會做的事
const FORBIDDEN_FIELDS = ['mcp_servers', 'container', 'service_tier'];
// messages 裡允許的內容區塊（App 只會送文字、工具呼叫與工具結果；thinking 是把 Claude 的回覆原樣帶回去用）
const BLOCK_TYPES = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking']);
const TOOL_KEYS = ['name', 'description', 'input_schema', 'strict', 'eager_input_streaming', 'cache_control'];
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MAX_MESSAGES = 200;
const MAX_TOOLS = 16;

function checkBlocks(blocks, where) {
  if (!Array.isArray(blocks)) throw bad('bad_request', `${where} 格式不正確`);
  for (const b of blocks) {
    if (!isObj(b) || !BLOCK_TYPES.has(b.type)) throw bad('block_type_not_allowed', `${where} 含有不開放的內容類型`);
    if (b.type === 'tool_result' && Array.isArray(b.content)) {
      for (const c of b.content) if (!isObj(c) || c.type !== 'text') throw bad('block_type_not_allowed', `${where} 的工具結果只能是文字`);
    }
  }
}

function cleanTool(t) {
  // 只接受 App 自己定義的 custom 工具；Anthropic 的內建工具（web_search_*、code_execution_*、bash_*、computer_*…）
  // 都有 type 欄位且不是 custom，一律拒絕
  if (!isObj(t) || (t.type !== undefined && t.type !== 'custom')) throw bad('tool_type_not_allowed', '只開放自訂工具，不能使用內建工具');
  if (typeof t.name !== 'string' || !TOOL_NAME.test(t.name) || !isObj(t.input_schema)) throw bad('bad_request', '工具定義不正確');
  const out = {};
  for (const k of TOOL_KEYS) if (t[k] !== undefined) out[k] = t[k];
  return out;
}

/**
 * 驗證 Claude 請求並回傳「重組後」的新物件（只含白名單欄位）。
 * 送給上游的一定是 JSON.stringify(這個物件)，絕不送原始內容：
 * 重複的鍵（例如兩個 "model"）、多餘的欄位都不可能穿過去。
 */
export function sanitizeClaudeRequest(json, config) {
  if (!isObj(json)) throw bad('bad_json', '內容不是 JSON 物件');
  for (const k of FORBIDDEN_FIELDS) if (k in json) throw bad('field_not_allowed', `不開放使用 ${k}`);

  if (typeof json.model !== 'string' || !config.anthropicModels.includes(json.model)) {
    throw bad('model_not_allowed', '這個 AI 模型不開放使用', 403);
  }
  const maxTokens = json.max_tokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw bad('max_tokens_required', '必須指定 max_tokens（正整數）');
  if (maxTokens > config.claudeMaxTokens) throw bad('max_tokens_too_large', `max_tokens 最多 ${config.claudeMaxTokens}`);

  if (!Array.isArray(json.messages) || json.messages.length < 1 || json.messages.length > MAX_MESSAGES) {
    throw bad('bad_request', 'messages 必須是 1～200 則訊息');
  }
  for (const m of json.messages) {
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant')) throw bad('bad_request', 'messages 格式不正確');
    if (typeof m.content !== 'string') checkBlocks(m.content, 'messages');
  }

  const out = { model: json.model, max_tokens: maxTokens, messages: json.messages.map((m) => ({ role: m.role, content: m.content })) };

  if (json.system !== undefined) {
    if (typeof json.system !== 'string') {
      if (!Array.isArray(json.system) || json.system.some((b) => !isObj(b) || b.type !== 'text')) throw bad('bad_request', 'system 格式不正確');
    }
    out.system = json.system;
  }
  if (json.tools !== undefined) {
    if (!Array.isArray(json.tools) || json.tools.length > MAX_TOOLS) throw bad('bad_request', 'tools 格式不正確');
    if (json.tools.length) out.tools = json.tools.map(cleanTool);
  }
  if (json.tool_choice !== undefined) {
    const c = json.tool_choice;
    if (!isObj(c) || !['auto', 'any', 'none', 'tool'].includes(c.type)) throw bad('bad_request', 'tool_choice 格式不正確');
    out.tool_choice = { type: c.type };
    if (c.type === 'tool') {
      if (typeof c.name !== 'string' || !TOOL_NAME.test(c.name)) throw bad('bad_request', 'tool_choice 格式不正確');
      out.tool_choice.name = c.name;
    }
    if (typeof c.disable_parallel_tool_use === 'boolean') out.tool_choice.disable_parallel_tool_use = c.disable_parallel_tool_use;
  }
  if (json.stream !== undefined) {
    if (typeof json.stream !== 'boolean') throw bad('bad_request', 'stream 必須是 true 或 false');
    out.stream = json.stream;
  }
  if (json.temperature !== undefined) {
    if (typeof json.temperature !== 'number' || json.temperature < 0 || json.temperature > 1) throw bad('bad_request', 'temperature 必須在 0～1');
    out.temperature = json.temperature;
  }
  if (json.output_config !== undefined) {
    const o = json.output_config;
    if (!isObj(o)) throw bad('bad_request', 'output_config 格式不正確');
    out.output_config = {};
    if (o.effort !== undefined) {
      if (!EFFORTS.has(o.effort)) throw bad('bad_request', 'effort 不正確');
      out.output_config.effort = o.effort;
    }
    if (o.format !== undefined) {
      if (!isObj(o.format) || o.format.type !== 'json_schema' || !isObj(o.format.schema)) throw bad('bad_request', 'output_config.format 格式不正確');
      out.output_config.format = { type: 'json_schema', schema: o.format.schema };
    }
  }
  if (json.fallbacks !== undefined) {
    // 只准用「預設備用模型」；自己指定模型清單會繞過上面的模型白名單
    if (json.fallbacks !== 'default') throw bad('field_not_allowed', 'fallbacks 只能是 "default"');
    out.fallbacks = 'default';
  }
  return out;
}

/** anthropic-beta 標頭：只留白名單內的值（未知的丟掉）；一個都沒有就回 null */
export function cleanBetaHeader(value, allowed) {
  if (typeof value !== 'string') return null;
  const keep = [...new Set(value.split(',').map((s) => s.trim()).filter((s) => allowed.includes(s)))];
  return keep.length ? keep.join(',') : null;
}

const isOpus = (model) => /opus/i.test(model);

/**
 * @param ctx { config, store, limiter, fetchImpl }
 * @param member 已驗證的成員（呼叫前已確認是家人）
 */
export async function forward(ctx, { req, res, url, body, member, writeCors }) {
  const { config, fetchImpl } = ctx;
  const kind = proxyKind(url.pathname);
  if (!kind) throw new HttpError(403, 'path_not_allowed', '這個路徑不開放代轉');
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '只能用 POST');

  const apiKey = kind === 'google' ? config.googleApiKey : config.anthropicApiKey;
  if (!apiKey) throw new HttpError(503, 'proxy_not_configured', '後台還沒設定這把金鑰');

  let json;
  try { json = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'bad_json', '內容不是 JSON'); }
  if (!json || typeof json !== 'object') throw new HttpError(400, 'bad_json', '內容不是 JSON');

  let upstream;
  let payload = body; // Google：原樣轉送；Claude：改送重組後的內容
  const headers = { 'Content-Type': 'application/json' };
  const usageKinds = [kind]; // 這次要計入哪些每日額度
  if (kind === 'google') {
    const r = GOOGLE_ROUTES[url.pathname];
    const mask = req.headers['x-goog-fieldmask'];
    if (typeof mask !== 'string' || !FIELD_MASK.test(mask)) throw new HttpError(400, 'bad_fieldmask', '缺少或不正確的 X-Goog-FieldMask');
    const base = config.googleBase || `https://${r.host}.googleapis.com`;
    upstream = `${base}${r.path}`;
    headers['X-Goog-Api-Key'] = apiKey;
    headers['X-Goog-FieldMask'] = mask;
    // Google 金鑰限制網址（HTTP referrer）時，後台代呼叫要帶同一個 Referer
    if (config.googleReferer) headers.Referer = config.googleReferer;
  } else {
    const clean = sanitizeClaudeRequest(json, config);
    payload = JSON.stringify(clean);
    if (isOpus(clean.model)) usageKinds.push('claude_opus');
    const beta = url.searchParams.get('beta') === 'true' ? '?beta=true' : '';
    upstream = `${config.anthropicBase}/v1/messages${beta}`;
    headers['x-api-key'] = apiKey;
    const ver = req.headers['anthropic-version'];
    headers['anthropic-version'] = typeof ver === 'string' && VERSION.test(ver) ? ver : '2023-06-01';
    const betaHeader = cleanBetaHeader(req.headers['anthropic-beta'], config.anthropicBetas);
    if (betaHeader) headers['anthropic-beta'] = betaHeader;
  }

  // 每日額度：所有模型合計一個上限；Opus（較貴）另外有較低的上限
  const limits = { google: config.googleDailyLimit, claude: config.claudeDailyLimit, claude_opus: config.claudeOpusDailyLimit };
  for (const k of usageKinds) {
    if (ctx.store.usage(member.id, k) >= limits[k]) {
      const label = k === 'google' ? 'Google 搜尋' : k === 'claude_opus' ? '進階 AI（Opus）' : 'AI';
      throw new HttpError(429, 'daily_limit', `今天的${label}次數用完了（每人每天 ${limits[k]} 次），明天再用`);
    }
  }
  for (const k of usageKinds) ctx.store.addUsage(member.id, k); // 先計數再轉送，避免同時送很多次繞過上限

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  let up;
  try {
    up = await fetchImpl(upstream, { method: 'POST', headers, body: payload, signal: ac.signal, redirect: 'error' });
  } catch {
    throw new HttpError(502, 'upstream_error', '連不上 Google／Claude，請稍後再試');
  }

  const out = { 'Content-Type': up.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' };
  const retry = up.headers.get('retry-after');
  if (retry) out['Retry-After'] = retry;
  writeCors(res);

  if (kind === 'google' || !up.body || !(up.headers.get('content-type') || '').includes('text/event-stream')) {
    // 一般回應：整段讀完，順手把金鑰字串遮掉（保險，Google 的回應本來就不會有）
    const text = redact(await up.text(), [config.googleApiKey, config.anthropicApiKey]);
    res.writeHead(up.status, out);
    res.end(text);
    return;
  }
  // Claude 串流（AI 行程）：邊收邊轉
  res.writeHead(up.status, out);
  Readable.fromWeb(up.body).on('error', () => res.end()).pipe(res);
}
