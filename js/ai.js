// Claude：幫忙從搜尋結果挑店、規劃一日行程
// 瀏覽器直接呼叫（金鑰只存在使用者手機），SDK 從 CDN 載入，用到才下載

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
const MODEL = 'claude-opus-5-5';
// 被安全機制拒答時，由伺服器自動改用建議的備用模型重跑
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
const MAX_TURNS = 12;

let cached = { key: null, client: null };
async function getClient(apiKey) {
  if (cached.key !== apiKey) {
    const { default: Anthropic } = await import(SDK_URL);
    cached = { key: apiKey, client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) };
  }
  return cached.client;
}

// API 錯誤轉成看得懂的中文
function friendly(err) {
  const msg = String(err?.error?.error?.message || err?.message || err);
  if (err?.status === 401) return new Error('Claude 金鑰無效，請到設定重新貼上');
  if (err?.status === 429) return new Error('請求太頻繁，稍等一下再試');
  if (/credit balance/i.test(msg)) return new Error('Claude 帳戶餘額不足，請到 Claude Console 儲值');
  if (err?.status >= 500) return new Error('Claude 暫時忙碌，稍後再試');
  return err instanceof Error ? err : new Error(msg);
}

async function withFriendlyErrors(fn) {
  try { return await fn(); } catch (err) { throw friendly(err); }
}

function checkStop(msg) {
  if (msg.stop_reason === 'refusal') throw new Error('AI 無法回答這個請求，換個說法試試');
}

// ---------- 同行成員 ----------
export function partyText(party) {
  const parts = [];
  if (party.adults) parts.push(`大人 ${party.adults} 位`);
  if (party.seniors) parts.push(`長輩 ${party.seniors} 位`);
  if (party.kids?.length) parts.push(`小孩 ${party.kids.length} 位（${party.kids.map((a) => `${a} 歲`).join('、')}）`);
  if (party.babies?.length) {
    parts.push(`幼兒 ${party.babies.length} 位（${party.babies.map((a) => (a === 0 ? '未滿 1 歲' : `${a} 歲`)).join('、')}）`);
  }
  if (party.veg) parts.push('有人吃素');
  let text = parts.join('、') || '未填寫';
  if (party.note?.trim()) text += `。備註：${party.note.trim()}`;
  return text;
}

// ---------- 從搜尋結果挑店 ----------
const PICKS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '一兩句總結，例如最推薦哪間、為什麼' },
    picks: {
      type: 'array',
      description: '推薦的 3 到 5 間，最推薦的放最前面',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '候選清單中的 id，必須完全一致' },
          reason: { type: 'string', description: '30 字內，說明為什麼適合這群人' },
        },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
    },
    tips: { type: 'string', description: '一句實用提醒，沒有就給空字串' },
  },
  required: ['summary', 'picks', 'tips'],
  additionalProperties: false,
};

const PICK_SYSTEM = `你是台灣在地的出遊助理，幫一家人從候選地點中挑出最適合的幾間。
判斷時考慮：同行成員（小孩年齡、幼兒是否需要推車與尿布台、長輩體力與是否方便停車或少走路）、評分與評論數的可信度、距離或繞路時間、抵達時是否營業、使用者指定的時間。
評論數很少的高分店家要打折看待。只能從候選清單挑，不要編造店家。用繁體中文回答，語氣自然精簡。`;

export function recommend(args) {
  return withFriendlyErrors(() => recommendRaw(args));
}

async function recommendRaw({ apiKey, party, context, places }) {
  const client = await getClient(apiKey);
  const msg = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: PICKS_SCHEMA } },
    system: PICK_SYSTEM,
    messages: [{
      role: 'user',
      content: `同行成員：${partyText(party)}\n${context}\n\n候選地點（JSON）：\n${JSON.stringify(places)}`,
    }],
  });
  checkStop(msg);
  const text = msg.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('AI 沒有回覆內容');
  return JSON.parse(text);
}

// ---------- 從評論整理每間店的招牌／特色（便宜快速的 Haiku） ----------
const HIGHLIGHT_MODEL = 'claude-haiku-5-5';
const HIGHLIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string', description: '20 字內；看不出來就給空字串' },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const HIGHLIGHT_SYSTEM = `你幫忙從 Google 評論整理每個地點的重點，讓人不用點進去看。
- 吃的、喝的：列出評論最常推薦的品項，最多 3 個，用「、」分隔，例如「西螺麻糬、花生湯圓、杏仁茶」。
- 其他地點（公園、親子館、停車場等）：一句話講最大特色，例如「有沙坑和大型溜滑梯，樹蔭多」。
- 20 字內，繁體中文，不要加「招牌：」之類的開頭。
- 只根據提供的評論和簡介，看不出來就給空字串，不要編造。`;

export function highlights(args) {
  return withFriendlyErrors(() => highlightsRaw(args));
}

async function highlightsRaw({ apiKey, places }) {
  const client = await getClient(apiKey);
  const msg = await client.messages.create({
    model: HIGHLIGHT_MODEL,
    max_tokens: 8000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: HIGHLIGHTS_SCHEMA } },
    system: HIGHLIGHT_SYSTEM,
    messages: [{ role: 'user', content: `地點（JSON）：\n${JSON.stringify(places)}` }],
  });
  checkStop(msg);
  const text = msg.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('AI 沒有回覆內容');
  return JSON.parse(text).items;
}

// ---------- 規劃行程（Claude 自己呼叫搜尋工具找真實店家） ----------
const SEARCH_TOOL = {
  name: 'search_places',
  description: '在 Google 地圖搜尋真實地點，回傳評分、評論數、類型、地址、距離與當天營業時間。'
    + '每個想放進行程的地點都必須先用這個工具查到。一次搜一種東西（例如「親子餐廳」「牛肉湯」「室內遊樂場」），可以同時呼叫多次。',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜尋關鍵字，用繁體中文，例如「親子館」「在地小吃」' },
      near: { type: 'string', description: '要在哪個地點附近搜尋（地名或地址）；空字串代表行程的出發地附近' },
    },
    required: ['query', 'near'],
    additionalProperties: false,
  },
  strict: true,
  eager_input_streaming: true,
};

const PLAN_SYSTEM = `你是台灣在地的行程規劃助理，幫一家人排出實際可行的行程。
規則：
- 只放用 search_places 查到的真實地點，名稱要和搜尋結果完全一致。
- 依同行成員安排：幼兒要考慮午睡、推車與換尿布；小孩依年齡選擇適合的活動；長輩避免走太多路與太趕。
- 每站都要在抵達時有營業，用餐時間要排到餐廳，地點之間的距離要合理，不要來回折返。
- 評分高且評論數多的優先，評論很少的高分店家打折看待。
輸出格式（給手機看，繁體中文，不要用表格、不要寫前言）：
## 行程總覽
一兩句說明這個行程的重點。
## 時間軸
每一站一段：
**10:00–11:30｜地點名稱**
- 為什麼適合這群人（一句）
- 小提醒（停車、預約、適合的年齡等，沒有就省略）
- 下一站移動方式與大約時間
## 注意事項
2 到 4 點。`;

/**
 * @param searchPlaces async (query, near) => 精簡後的地點陣列（每筆含 name、mapsUrl）
 * @param onTurn 每一輪開始時呼叫（清掉上一輪的草稿文字）
 * @param onText 串流文字片段
 * @param onStatus 狀態文字（例如正在搜尋什麼）
 * @returns { text, places: Map<名稱, mapsUrl> }
 */
export function planTrip(args) {
  return withFriendlyErrors(() => planTripRaw(args));
}

async function planTripRaw({ apiKey, prompt, searchPlaces, onTurn, onText, onStatus }) {
  const client = await getClient(apiKey);
  const messages = [{ role: 'user', content: prompt }];
  const places = new Map();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    onTurn();
    onStatus(turn === 0 ? 'AI 思考中…' : 'AI 整理中…');
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      ...FALLBACK,
      output_config: { effort: 'medium' },
      system: PLAN_SYSTEM,
      tools: [SEARCH_TOOL],
      messages,
    });
    stream.on('text', (t) => onText(t));
    const msg = await stream.finalMessage();
    checkStop(msg);
    messages.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason === 'pause_turn') continue;
    const uses = msg.content.filter((b) => b.type === 'tool_use');
    if (msg.stop_reason !== 'tool_use' || !uses.length) {
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { text, places };
    }
    if (msg.stop_reason === 'max_tokens') throw new Error('AI 回覆太長被截斷，請把需求寫短一點');

    const results = await Promise.all(uses.map(async (u) => {
      const { query, near } = u.input || {};
      if (typeof query !== 'string' || !query.trim() || typeof near !== 'string') {
        return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'INVALID_INPUT：query 與 near 都必須是字串，query 不可空白' };
      }
      onStatus(`AI 正在搜尋：${query}${near ? `（${near}附近）` : ''}`);
      try {
        const list = await searchPlaces(query.trim(), near.trim());
        for (const p of list) places.set(p.name, p.mapsUrl);
        return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(list.map(({ mapsUrl, ...rest }) => rest)) };
      } catch (err) {
        return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: `搜尋失敗：${err.message}` };
      }
    }));
    messages.push({ role: 'user', content: results });
  }
  throw new Error('AI 搜尋太多次還沒排完，請把需求寫具體一點再試');
}
