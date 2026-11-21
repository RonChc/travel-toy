// 啟動：node src/index.js（設定放在 server/.env，見 README）
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

let config;
let app;
try {
  config = loadConfig();
  app = createApp({ config });
} catch (e) {
  console.error('❌ 後台無法啟動：' + e.message);
  process.exit(1);
}

if (!config.createCode) console.warn('⚠️  .env 沒有 GROUP_CREATE_CODE，沒有人能建立群組（請先執行 npm run setup）');
if (!config.googleApiKey && !config.anthropicApiKey) console.warn('ℹ️  沒有設定 GOOGLE_API_KEY／ANTHROPIC_API_KEY，家人代轉功能會回 503');
if (!config.vapidPublic) console.warn('ℹ️  沒有 VAPID 金鑰，推播通知關閉（只剩 App 開著時的提示）');

app.sweep();
const timer = setInterval(() => { try { app.sweep(); } catch (e) { console.error('清理失敗：', e.message); } }, 60e3);
timer.unref();

const server = createServer(app.handler);
server.requestTimeout = 120e3;
server.listen(config.port, config.host, () => {
  console.log(`群組後台已啟動：http://${config.host}:${config.port}（本機）`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); app.close(); process.exit(0); });
}
