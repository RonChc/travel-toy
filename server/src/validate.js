// 輸入檢查：所有使用者給的資料都先過這裡
export const EMOJIS = ['😀', '😎', '🥳', '🤠', '🐶', '🐱', '🐰', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐵', '🦄', '🐥', '🌻', '🍀', '🍎', '🍓', '⚽', '🎈', '🚗', '⭐'];

const CONTROL = /[\u0000-\u001f\u007f]/;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const bad = (message) => new HttpError(400, 'bad_request', message);

export function cleanText(v, { min = 0, max, label }) {
  if (typeof v !== 'string') throw bad(`${label}格式不對`);
  const s = v.trim();
  if (CONTROL.test(s)) throw bad(`${label}含有不能用的字元`);
  const len = [...s].length;
  if (len < min || len > max) throw bad(min ? `${label}請輸入 ${min}～${max} 個字` : `${label}最多 ${max} 個字`);
  return s;
}

export const cleanName = (v) => cleanText(v, { min: 1, max: 20, label: '名字' });
export const cleanGroupName = (v) => cleanText(v, { min: 1, max: 30, label: '群組名稱' });

export function cleanEmoji(v) {
  if (!EMOJIS.includes(v)) throw bad('請從清單選一個表情');
  return v;
}

export function cleanNote(v) {
  if (v === undefined || v === null || v === '') return null;
  return cleanText(String(v).replace(/[\r\n]+/g, ' '), { max: 100, label: '留言' }) || null;
}

const FLOOR = /^(?:B[1-9]|[1-9]|1\d|20)F$|^戶外$/;
export function cleanFloor(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !FLOOR.test(v)) throw bad('樓層格式不對');
  return v;
}

const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export function cleanCoords(b) {
  if (!b || typeof b !== 'object') throw bad('缺少位置');
  if (!inRange(b.lat, -90, 90) || !inRange(b.lng, -180, 180)) throw bad('位置座標不正確');
  const accuracy = b.accuracy === undefined || b.accuracy === null ? null : b.accuracy;
  if (accuracy !== null && !inRange(accuracy, 0, 1e6)) throw bad('位置精準度不正確');
  return { lat: b.lat, lng: b.lng, accuracy };
}

// 推播訂閱：端點只允許已知的推播服務（避免後台被拿去連任意網址）
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const B64URL = /^[A-Za-z0-9_-]{8,200}={0,2}$/;

export function cleanSubscription(sub, extraHosts = []) {
  let url;
  try { url = new URL(sub?.endpoint); } catch { throw bad('推播訂閱格式不對'); }
  const okHost = PUSH_HOSTS.some((re) => re.test(url.hostname)) || extraHosts.includes(url.hostname);
  if (url.protocol !== 'https:' || !okHost || String(sub.endpoint).length > 1000) throw bad('不支援的推播服務');
  if (!B64URL.test(sub.keys?.p256dh || '') || !B64URL.test(sub.keys?.auth || '')) throw bad('推播金鑰格式不對');
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}
