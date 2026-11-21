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
    googleBase: (env.GOOGLE_UPSTREAM_BASE || '').replace(/\/$/, ''), // 測試時指到假上游；空白＝正式網址
    anthropicBase: (env.ANTHROPIC_UPSTREAM_BASE || 'https://api.anthropic.com').replace(/\/$/, ''),
    claudeDailyLimit: num(env.CLAUDE_DAILY_LIMIT, 50), // 每位家人每天呼叫 Claude 次數
    googleDailyLimit: num(env.GOOGLE_DAILY_LIMIT, 500),
    vapidPublic: env.VAPID_PUBLIC_KEY || '',
    vapidPrivate: env.VAPID_PRIVATE_KEY || '',
    vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
    extraOrigins: list(env.EXTRA_ORIGINS), // 額外允許的前端網址（完整 origin）
    trustProxy: env.TRUST_PROXY === '1', // 放在 Tailscale Funnel／Cloudflare 後面時設 1，才信 X-Forwarded-For
    groupTtlMs: num(env.GROUP_TTL_HOURS, 168) * 3600e3, // 7 天
    maxMembers: num(env.MAX_MEMBERS, 30),
    maxPhotoBytes: num(env.MAX_PHOTO_BYTES, 2 * 1024 * 1024),
    findTtlMs: num(env.FIND_TTL_MINUTES, 60) * 60e3, // 找人請求逾時不再提示
    pushHostsExtra: list(env.PUSH_HOSTS_EXTRA),
    // 頻率限制：{ max, windowMs }
    limits: {
      authFail: { max: num(env.RL_AUTH_FAIL, 20), windowMs: 60e3 }, // 每個 IP 每分鐘猜錯權杖次數
      create: { max: num(env.RL_CREATE, 5), windowMs: 3600e3 },
      join: { max: num(env.RL_JOIN, 20), windowMs: 600e3 },
      find: { max: num(env.RL_FIND, 12), windowMs: 60e3 },
      upload: { max: num(env.RL_UPLOAD, 10), windowMs: 60e3 },
      proxy: { max: num(env.RL_PROXY, 60), windowMs: 60e3 },
      location: { max: num(env.RL_LOCATION, 30), windowMs: 60e3 },
      general: { max: num(env.RL_GENERAL, 300), windowMs: 60e3 },
    },
  };
  return { ...c, ...overrides, limits: { ...c.limits, ...(overrides.limits || {}) } };
}

export function loadConfig() {
  return buildConfig({ ...loadEnvFile(), ...process.env });
}
