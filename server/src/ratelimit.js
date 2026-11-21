// 簡單的固定視窗頻率限制（記憶體內，重開機歸零）
export const MAX_ENTRIES = 100000; // 記錄筆數上限：超過就丟掉最舊的，避免被大量不同來源撐爆記憶體

export function createLimiter(now = () => Date.now(), { maxEntries = MAX_ENTRIES } = {}) {
  const hits = new Map(); // `${bucket}|${key}` → { n, reset }
  let lastSweep = now();

  function sweep() {
    const t = now();
    if (t - lastSweep < 60e3) return;
    lastSweep = t;
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }

  // 超過上限：先清過期的，還是太多就從最舊的開始丟（Map 依建立順序走訪）
  function enforceCap() {
    if (hits.size <= maxEntries) return;
    const t = now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
    for (const k of hits.keys()) {
      if (hits.size <= maxEntries) break;
      hits.delete(k);
    }
  }

  return {
    /** 回傳 { ok, retryAfter }；ok=false 表示超過上限。cost：這次算幾次（例如一次找 5 個人＝5） */
    hit(bucket, key, { max, windowMs }, cost = 1) {
      sweep();
      const t = now();
      const id = `${bucket}|${key}`;
      let h = hits.get(id);
      if (!h || h.reset <= t) {
        h = { n: 0, reset: t + windowMs };
        hits.set(id, h);
        enforceCap();
      }
      h.n += cost;
      return { ok: h.n <= max, retryAfter: Math.ceil((h.reset - t) / 1000) };
    },
    /** 只看不計數：還沒用完額度就回 true（cost：這次打算用幾次） */
    peek(bucket, key, { max }, cost = 1) {
      const h = hits.get(`${bucket}|${key}`);
      return !h || h.reset <= now() || h.n + cost <= max;
    },
    /** 還要等幾秒才會重置（沒有記錄回 0） */
    retryAfter(bucket, key) {
      const h = hits.get(`${bucket}|${key}`);
      return h && h.reset > now() ? Math.ceil((h.reset - now()) / 1000) : 0;
    },
    size: () => hits.size,
    clear() { hits.clear(); },
  };
}
