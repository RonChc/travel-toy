// 只印出一組新的 VAPID 金鑰（要手動換金鑰時用）。私鑰不要貼到任何公開的地方。
import webpush from 'web-push';

const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${k.privateKey}`);
console.log('把這兩行貼進 server/.env（換金鑰後，大家要重新開啟通知）。');
