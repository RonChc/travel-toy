// 群組後台代轉：家人沒有自己的金鑰時，Google／Claude 都改走後台（金鑰只在後台，不在手機）
export const VIA_PROXY = '@proxy'; // 傳進 api.js／ai.js 的「金鑰」，代表走後台代轉
export const gateway = { base: '', token: '', onDenied: null }; // onDenied：後台說「你是朋友」時通知群組畫面更新身分

export function setGateway(base, token) {
  gateway.base = (base || '').replace(/\/+$/, '');
  gateway.token = token || '';
}

// Google 上游網址 → 後台代轉路徑（只有 App 用到的四個）
const GOOGLE_MAP = {
  'https://places.googleapis.com/v1/places:searchNearby': '/api/proxy/google/places/searchNearby',
  'https://places.googleapis.com/v1/places:searchText': '/api/proxy/google/places/searchText',
  'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix': '/api/proxy/google/routes/computeRouteMatrix',
  'https://routes.googleapis.com/directions/v2:computeRoutes': '/api/proxy/google/routes/computeRoutes',
};

export function googleProxyUrl(url) {
  const p = GOOGLE_MAP[url];
  if (!p) throw new Error('這個功能不能透過群組後台使用');
  return gateway.base + p;
}

export const anthropicProxyBase = () => `${gateway.base}/api/proxy/anthropic`;

// 後台回 403 friend_no_proxy 時丟這個錯，畫面會提示「請自己輸入金鑰」
export class ProxyDenied extends Error {
  constructor(message) {
    super(message || '你在群組裡是「朋友」，不能用共用金鑰，請到 ⚙️ 設定自己輸入金鑰');
    this.name = 'ProxyDenied';
    gateway.onDenied?.();
  }
}
