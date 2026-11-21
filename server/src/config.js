// 設定：從環境變數與 server/.env 讀取（.env 不進 git）
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

// 極簡 .env 解析（KEY=VALUE，# 開頭是註解），不依賴 dotenv
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

export function loadEnvFile(file = join(SERVER_DIR, '.env')) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

// 建立暗號至少要這麼長（管理員＝家人＝能用老闆的金鑰，暗號太短等於沒鎖）
export const MIN_CREATE_CODE = 12;

// TRUST_PROXY：明確指定「來源 IP 要相信誰帶來的哪個標頭」，其餘一律不信（避免使用者自己帶假標頭繞過頻率限制）
//   （空白／none）直接對外或本機：只看連線本身的 IP
//   cloudflare：Cloudflare Tunnel 後面，只信 CF-Connecting-IP
//   tailscale ：Tailscale Funnel 後面，只取 X-Forwarded-For 最右邊那一個（通道自己附加的）
export const TRUST_MODES = ['none', 'cloudflare', 'tailscale'];
export function parseTrustProxy(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (t === '' || t === '0' || t === 'none' || t === 'false') return 'none';
  if (TRUST_MODES.includes(t)) return t;
  throw new Error(`TRUST_PROXY 只能是 none、cloudflare 或 tailscale（目前是「${v}」；舊的 1 已不再支援，請依通道改成 cloudflare 或 tailscale）`);
}

// L-d：用通道（cloudflare／tailscale）時，後台只能經由通道連到，所以必須只聽本機；
// 否則別人可直接連後台、自己帶假標頭繞過頻率限制。
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];
export function assertTrustProxyBinding(trustProxy, host) {
  if (trustProxy === 'none' || LOOPBACK_HOSTS.includes(String(host).trim().toLowerCase())) return;
  throw new Error(`TRUST_PROXY=${trustProxy}（有通道）時，HOST 只能是 127.0.0.1（只讓本機連），目前是「${host}」。` +
    '否則別人可以繞過通道直接連到後台、用假標頭騙過頻率限制。請把 .env 的 HOST 改回 127.0.0.1，或把 TRUST_PROXY 改成 none。');
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/** env：process.env 合併 .env；overrides：測試用直接覆寫 */
export function buildConfig(env = {}, overrides = {}) {
  const c = {
    port: num(env.PORT, 8787),
    host: env.HOST || '127.0.0.1',
    dataDir: env.DATA_DIR || join(SERVER_DIR, 'data'),
    dbFile: env.DB_FILE || '',
    // 建立群組要有這組暗號，否則任何知道網址的人都能建群組當管理員（管理員＝家人＝能用老闆的金鑰）
    createCode: env.GROUP_CREATE_CODE || '',
    googleApiKey: env.GOOGLE_API_KEY || '',
    googleReferer: env.GOOGLE_REFERER || 'https://ronchc.github.io/',
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    anthropicModels: list(env.ALLOWED_CLAUDE_MODELS || 'claude-opus-5-5,claude-haiku-5-5,claude-sonnet-5-5'),
    // 允許轉送的 anthropic-beta 值（其餘會被丟掉）。App 的「被拒答時自動改用備用模型」要用到這個
    anthropicBetas: list(env.ALLOWED_CLAUDE_BETAS || 'server-side-fallback-2026-07-01'),
    claudeMaxTokens: num(env.CLAUDE_MAX_TOKENS, 16000), // 單次請求 max_tokens 上限（必填）
    googleBase: (env.GOOGLE_UPSTREAM_BASE || '').replace(/\/$/, ''), // 測試時指到假上游；空白＝正式網址
    anthropicBase: (env.ANTHROPIC_UPSTREAM_BASE || 'https://api.anthropic.com').replace(/\/$/, ''),
    claudeDailyLimit: num(env.CLAUDE_DAILY_LIMIT, 50), // 每位家人每天呼叫 Claude 次數（所有模型合計）
    claudeOpusDailyLimit: num(env.CLAUDE_OPUS_DAILY_LIMIT, 20), // 其中 Opus（較貴）另外限制，每位每天
    googleDailyLimit: num(env.GOOGLE_DAILY_LIMIT, 500),
    vapidPublic: env.VAPID_PUBLIC_KEY || '',
    vapidPrivate: env.VAPID_PRIVATE_KEY || '',
    vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
    extraOrigins: list(env.EXTRA_ORIGINS), // 額外允許的前端網址（完整 origin）
    trustProxy: parseTrustProxy(env.TRUST_PROXY), // none／cloudflare／tailscale，見上方說明
    dev: env.DEV === '1', // 開發模式：允許 http://localhost 當前端來源（正式上線不要開）
    groupTtlMs: num(env.GROUP_TTL_HOURS, 168) * 3600e3, // 7 天
    maxMembers: num(env.MAX_MEMBERS, 30),
    maxPhotoBytes: num(env.MAX_PHOTO_BYTES, 2 * 1024 * 1024),
    findTtlMs: num(env.FIND_TTL_MINUTES, 60) * 60e3, // 找人請求逾時不再提示
    pushHostsExtra: list(env.PUSH_HOSTS_EXTRA),
    // 頻率限制：{ max, windowMs }
    limits: {
      authFail: { max: num(env.RL_AUTH_FAIL, 20), windowMs: 60e3 }, // 每個 IP 每分鐘猜錯權杖次數
      create: { max: num(env.RL_CREATE, 5), windowMs: 3600e3 }, // 每個 IP 每小時「猜錯建立暗號」次數（猜對的不算）
      join: { max: num(env.RL_JOIN, 20), windowMs: 600e3 },
      find: { max: num(env.RL_FIND, 40), windowMs: 60e3 }, // 每人每分鐘找人次數（一次找全部＝人數）
      findPair: { max: 1, windowMs: num(env.FIND_PAIR_COOLDOWN_SECONDS, 60) * 1000 }, // 同一對（發問者→目標）冷卻
      upload: { max: num(env.RL_UPLOAD, 10), windowMs: 60e3 },
      proxy: { max: num(env.RL_PROXY, 60), windowMs: 60e3 },
      location: { max: num(env.RL_LOCATION, 30), windowMs: 60e3 },
      general: { max: num(env.RL_GENERAL, 300), windowMs: 60e3 },
    },
  };
  const out = { ...c, ...overrides, limits: { ...c.limits, ...(overrides.limits || {}) } };
  assertTrustProxyBinding(out.trustProxy, out.host);
  return out;
}

export function loadConfig() {
  return buildConfig({ ...loadEnvFile(), ...process.env });
}
