// 第一次設定：產生 server/.env（建立暗號＋VAPID 金鑰）。已存在就不覆蓋。
// 用法：npm run setup
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { SERVER_DIR } from '../src/config.js';

const file = join(SERVER_DIR, '.env');
if (existsSync(file)) {
  console.log(`.env 已存在，不覆蓋：${file}`);
  console.log('要重新產生請先自己備份並刪掉它。');
  process.exit(0);
}

const vapid = webpush.generateVAPIDKeys();
const example = readFileSync(join(SERVER_DIR, '.env.example'), 'utf8');
const filled = example
  .replace(/^GROUP_CREATE_CODE=.*$/m, `GROUP_CREATE_CODE=${randomBytes(12).toString('base64url')}`)
  .replace(/^VAPID_PUBLIC_KEY=.*$/m, `VAPID_PUBLIC_KEY=${vapid.publicKey}`)
  .replace(/^VAPID_PRIVATE_KEY=.*$/m, `VAPID_PRIVATE_KEY=${vapid.privateKey}`);
writeFileSync(file, filled, { mode: 0o600 });

console.log(`已建立 ${file}`);
console.log('接下來請用文字編輯器打開它，填入 GOOGLE_API_KEY、ANTHROPIC_API_KEY、VAPID_SUBJECT。');
console.log('GROUP_CREATE_CODE（建立群組用的暗號）已隨機產生，請打開 .env 查看並記下來。');
