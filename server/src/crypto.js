import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// 權杖：256 位元亂數（遠大於 128 位元），後台只存 sha256 雜湊
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export const newId = () => randomBytes(9).toString('hex'); // 公開用的代號（不是祕密）
export const randomName = () => randomBytes(16).toString('hex'); // 照片隨機檔名

// 比對祕密字串：兩邊先 sha256 成等長，再用 timingSafeEqual。
// 長度不同也不會提早回傳，不會洩漏「暗號有幾個字」。
export function safeEqual(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}
