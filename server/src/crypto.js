import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// 權杖：256 位元亂數（遠大於 128 位元），後台只存 sha256 雜湊
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export const newId = () => randomBytes(9).toString('hex'); // 公開用的代號（不是祕密）
export const randomName = () => randomBytes(16).toString('hex'); // 照片隨機檔名

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
