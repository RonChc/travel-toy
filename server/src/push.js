// Web Push：包 web-push，可在測試時換成假的 sender
import webpush from 'web-push';

export function createPusher(config, sender) {
  const enabled = !!(config.vapidPublic && config.vapidPrivate);
  if (enabled && !sender) webpush.setVapidDetails(config.vapidSubject, config.vapidPublic, config.vapidPrivate);
  const send = sender || ((sub, payload) => webpush.sendNotification(sub, payload, { TTL: 120, urgency: 'high' }));

  return {
    enabled: enabled || !!sender,
    publicKey: config.vapidPublic,
    /**
     * 對某位成員發通知。回傳 'sent' | 'gone'（訂閱已失效）| 'none'（沒訂閱或沒開推播）| 'error'
     * 永遠不丟錯，推播失敗不能影響找人流程。
     */
    async notify(member, payload) {
      if (!member.push_sub || (!enabled && !sender)) return 'none';
      let sub;
      try { sub = JSON.parse(member.push_sub); } catch { return 'gone'; }
      try {
        await Promise.race([
          send(sub, JSON.stringify(payload)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('push timeout')), 8000).unref()),
        ]);
        return 'sent';
      } catch (err) {
        return err?.statusCode === 404 || err?.statusCode === 410 ? 'gone' : 'error';
      }
    },
  };
}
