// 簡單的固定視窗頻率限制（記憶體內，重開機歸零）
export function createLimiter(now = () => Date.now()) {
  const hits = new Map(); // `${bucket}|${key}` → { n, reset }
  let lastSweep = now();

  function sweep() {
    const t = now();
    if (t - lastSweep < 60e3) return;
    lastSweep = t;
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }

  return {
    /** 回傳 { ok, retryAfter }；ok=false 表示超過上限 */
    hit(bucket, key, { max, windowMs }) {
      sweep();
      const t = now();
      const id = `${bucket}|${key}`;
      let h = hits.get(id);
      if (!h || h.reset <= t) {
        h = { n: 0, reset: t + windowMs };
        hits.set(id, h);
      }
      h.n += 1;
      return { ok: h.n <= max, retryAfter: Math.ceil((h.reset - t) / 1000) };
    },
    /** 只看不計數（用於已被鎖住的 IP） */
    peek(bucket, key, { max }) {
      const h = hits.get(`${bucket}|${key}`);
      return !h || h.reset <= now() || h.n < max;
    },
    clear() { hits.clear(); },
  };
}
