// 金鑰代轉：家人手機呼叫後台，後台帶著老闆的金鑰去呼叫 Google／Claude。
// 金鑰只在這個檔案轉送時使用，不會出現在任何回應裡。只轉送 App 實際用到的路徑。
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
const BETA = /^[A-Za-z0-9_,.\- ]{1,500}$/;
const VERSION = /^[0-9-]{1,20}$/;
const MAX_TOKENS = 64000;

export const isProxyPath = (path) => path.startsWith('/api/proxy/');

export function proxyKind(path) {
  if (GOOGLE_ROUTES[path]) return 'google';
  if (path === ANTHROPIC_PATH) return 'claude';
  return null;
}

const redact = (text, secrets) => secrets.filter(Boolean).reduce((t, s) => t.split(s).join('***'), text);

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

  const dailyMax = kind === 'google' ? config.googleDailyLimit : config.claudeDailyLimit;
  if (ctx.store.usage(member.id, kind) >= dailyMax) {
    throw new HttpError(429, 'daily_limit', `今天的${kind === 'google' ? 'Google 搜尋' : 'AI'}次數用完了（每人每天 ${dailyMax} 次），明天再用`);
  }

  let json;
  try { json = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'bad_json', '內容不是 JSON'); }
  if (!json || typeof json !== 'object') throw new HttpError(400, 'bad_json', '內容不是 JSON');

  let upstream;
  const headers = { 'Content-Type': 'application/json' };
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
    if (typeof json.model !== 'string' || !config.anthropicModels.includes(json.model)) {
      throw new HttpError(403, 'model_not_allowed', '這個 AI 模型不開放使用');
    }
    if (typeof json.max_tokens === 'number' && json.max_tokens > MAX_TOKENS) throw new HttpError(400, 'max_tokens_too_large', 'max_tokens 太大');
    const beta = url.searchParams.get('beta') === 'true' ? '?beta=true' : '';
    upstream = `${config.anthropicBase}/v1/messages${beta}`;
    headers['x-api-key'] = apiKey;
    const ver = req.headers['anthropic-version'];
    headers['anthropic-version'] = typeof ver === 'string' && VERSION.test(ver) ? ver : '2023-06-01';
    const betaHeader = req.headers['anthropic-beta'];
    if (typeof betaHeader === 'string' && BETA.test(betaHeader)) headers['anthropic-beta'] = betaHeader;
  }

  ctx.store.addUsage(member.id, kind); // 先計數再轉送，避免同時送很多次繞過上限

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  let up;
  try {
    up = await fetchImpl(upstream, { method: 'POST', headers, body, signal: ac.signal });
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
