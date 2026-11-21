// 放進 href 之前先過這裡：只接受 https:// 網址（擋掉 javascript:、data:、http: 等）
// 回傳整理過的網址字串；不合格回空字串
export function safeHttpsUrl(url) {
  try {
    const u = new URL(String(url ?? ''));
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}
