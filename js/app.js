import { CATEGORIES } from './categories.js';
import { cuisineLabel, shopKind, placeLabel } from './classify.js';
import { isOpenAt, hoursOn, fmtClock } from './hours.js';
import * as realApi from './api.js';
import * as mockApi from './mock.js';
import * as realAi from './ai.js';

const MOCK = new URLSearchParams(location.search).has('mock');
const api = MOCK ? mockApi : realApi;
const ai = MOCK ? mockApi.ai : realAi;
const MAX_CANDIDATES = 25; // 附近模式送去算路程的最多筆數（依直線距離取最近）

const SORTS = {
  nearby: [['distance', '由近到遠'], ['fastest', '最快抵達'], ['rating', '評分高到低'], ['reviews', '評論數多到少']],
  route: [['detour', '繞路最少'], ['rating', '評分高到低'], ['reviews', '評論數多到少'], ['order', '沿路先到']],
};

const $ = (sel) => document.querySelector(sel);

// ---------- 偏好設定（只存在這台手機） ----------
const PREF_KEY = 'travel-toy-prefs';
const PREF_FIELDS = ['key', 'claudeKey', 'party', 'view', 'mode', 'radius', 'maxDetour', 'minRating', 'minReviews', 'openOnly', 'sortNearby', 'sortRoute'];
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
}
function savePrefs() {
  const out = Object.fromEntries(PREF_FIELDS.map((k) => [k, state[k]]));
  try { localStorage.setItem(PREF_KEY, JSON.stringify(out)); } catch { /* 無痕模式等情況存不了，略過 */ }
}

const state = {
  key: '', claudeKey: '', view: 'nearby', mode: 'DRIVE', radius: 3000, maxDetour: 600,
  minRating: 0, minReviews: 0, openOnly: false, sortNearby: 'distance', sortRoute: 'detour',
  party: { adults: 2, seniors: 0, kids: [], babies: [], note: '' },
  ...loadPrefs(),
  aiPicks: new Map(), // AI 推薦：id → 理由
  here: null, // GPS 目前位置
  origin: null, // 附近模式的中心點
  route: null, // 順路模式：{ a, b, seconds, meters, polyline, mode }
  query: null, // { cat } 或 { text }
  food: false,
  places: [],
  routes: { DRIVE: new Map(), WALK: new Map() }, // 附近模式的路程時間快取
  showCount: 10,
  searchId: 0,
  cuisine: null, // 吃的類別：選定的料理類型
  kind: null, // 吃的類別：「餐廳」或「小吃店」
  when: null, // 什麼時候去：null = 現在，或 { day: 0|1|2（今天起算）, time: 'HH:MM' }
};

const sortKey = () => (state.view === 'route' ? 'sortRoute' : 'sortNearby');
const isSearchView = () => state.view !== 'plan';

// ---------- 工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} 公尺` : `${(m / 1000).toFixed(1)} 公里`);
function fmtTime(sec) {
  const min = Math.max(1, Math.round(sec / 60));
  return min < 60 ? `${min} 分` : `${Math.floor(min / 60)} 小時 ${min % 60} 分`;
}
const modeIcon = () => (state.mode === 'DRIVE' ? '🚗' : '🚶');
const modeWord = () => (state.mode === 'DRIVE' ? '開車' : '走路');

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3500);
}

function requireKey() {
  if (MOCK || state.key) return true;
  openSettings();
  toast('請先輸入 Google API 金鑰');
  return false;
}

// ---------- 營業時間 ----------
const DAY_WORDS = ['今天', '明天', '後天'];

function whenDate() {
  if (!state.when) return new Date();
  const [h, m] = state.when.time.split(':').map(Number);
  const d = new Date();
  d.setDate(d.getDate() + state.when.day);
  d.setHours(h, m, 0, 0);
  return d;
}

const isArrive = () => state.when?.type === 'arrive';
const whenWord = () => (state.when ? `${DAY_WORDS[state.when.day]} ${state.when.time}` : '現在');

// 從起點到這間店要幾秒（附近模式用路程矩陣，順路模式用起點→店那段），還沒算出來回傳 undefined
function travelSeconds(p) {
  return state.view === 'route' ? p.toPlace?.seconds : state.routes[state.mode].get(p.id)?.seconds;
}

// 抵達這間店的時間：指定抵達就是那個時間；出發（含現在）則是出發時間＋路程
function arrivalTime(p) {
  if (isArrive()) return whenDate();
  return new Date(whenDate().getTime() + (travelSeconds(p) || 0) * 1000);
}

// 依抵達時間用每週營業時間推算；沒有營業時間資料時，「現在出發」才退回 Google 的 openNow
function openStatus(p) {
  const byHours = isOpenAt(p, arrivalTime(p));
  if (!state.when) {
    const googleNow = p.currentOpeningHours?.openNow;
    // 每週時間說現在有開、Google 卻說沒開 → 今天臨時公休或特殊時段
    if (googleNow === false && isOpenAt(p, new Date()) === true) return false;
    return byHours ?? googleNow;
  }
  return byHours;
}

function openTag(p) {
  const open = openStatus(p);
  if (open === undefined) return autoOpen() ? '<span class="tag tag-unknown">時間不明</span>' : '';
  const text = isArrive()
    ? `${whenWord()} ${open ? '有營業' : '沒營業'}`
    : (open ? '抵達時營業中' : '抵達時沒營業');
  return `<span class="tag ${open ? 'tag-open' : 'tag-closed'}">${text}</span>`;
}

// 出發 → 顯示大約幾點到；抵達 → 顯示要幾點出發
function clockNote(p) {
  const sec = travelSeconds(p);
  if (sec === undefined) return '';
  if (isArrive()) return `（${fmtClock(new Date(whenDate().getTime() - sec * 1000))} 出發）`;
  return `（約 ${fmtClock(arrivalTime(p))} 到）`;
}

// 只有「現在＋附近」才請 Google 直接過濾營業中，其他時間要拿到全部再自己判斷
const serverOpenNow = (q) => !!q.cat?.openNow && !state.when && state.view === 'nearby';

// 餐點類別：時間是「現在」但還沒到用餐時段，自動改看今天的用餐時間
function applyMealTime(cat) {
  if (state.when || !cat.mealTime) return;
  const now = fmtClock(new Date());
  if (now >= cat.mealTime.start) return;
  state.when = { type: 'arrive', day: 0, time: cat.mealTime.pick };
  syncWhen();
  toast(`還沒到${cat.name}時間，改看今天 ${cat.mealTime.pick} 抵達有營業的`);
}

function syncWhen() {
  $('#when-type').value = state.when?.type || '';
  $('#when-day').value = String(state.when?.day ?? 0);
  $('#when-time').value = state.when?.time || '';
  $('#when-day').hidden = !state.when;
  $('#when-time').hidden = !state.when;
}

const queryName = (q) => (q.cat ? q.cat.name : `「${q.text}」`);
const isFoodPlace = (p) => (p.types || []).some((t) => /restaurant|meal_|food|cafe|bakery/.test(t));

// ---------- 定位 ----------
function setOrigin(origin) {
  state.origin = origin;
  $('#origin-label').textContent = origin.label;
  if (state.query && state.view === 'nearby') runSearch();
}

function locateMe() {
  if (!navigator.geolocation) return toast('這個瀏覽器不支援定位');
  $('#origin-label').textContent = '定位中…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.here = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: '📍 目前位置' };
      setOrigin(state.here);
    },
    (err) => {
      $('#origin-label').textContent = state.origin?.label || '尚未設定位置';
      toast(err.code === 1 ? '沒有定位權限，請改用輸入地址' : '定位失敗，請再試一次或輸入地址');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
}

async function searchAddress(e) {
  e.preventDefault();
  const text = $('#address').value.trim();
  if (!text || !requireKey()) return;
  try {
    $('#origin-label').textContent = '搜尋地點中…';
    const o = await api.geocode(state.key, text);
    setOrigin({ ...o, label: `📌 ${o.label}` });
    $('#address').blur();
  } catch (err) {
    $('#origin-label').textContent = state.origin?.label || '尚未設定位置';
    toast(`找不到地點：${err.message}`);
  }
}

const geoCache = new Map();
async function geocodeCached(text) {
  if (!geoCache.has(text)) geoCache.set(text, await api.geocode(state.key, text));
  return geoCache.get(text);
}

// 順路模式：取得 A→B 路線（A 留空 = 目前位置），輸入沒變就沿用
async function ensureRoute() {
  const aText = $('#route-a').value.trim();
  const bText = $('#route-b').value.trim();
  if (!bText) throw new Error('請輸入終點 B');
  let a;
  if (aText) a = { ...(await geocodeCached(aText)), text: aText };
  else if (state.here) a = { ...state.here, label: '目前位置', text: '' };
  else throw new Error('還沒定位到目前位置，請輸入起點 A');
  const b = { ...(await geocodeCached(bText)), text: bText };

  const r = state.route;
  if (r && r.mode === state.mode && r.a.text === a.text && r.b.text === b.text
    && r.a.lat === a.lat && r.a.lng === a.lng) return r;
  const res = await api.computeRoute(state.key, a, b, state.mode);
  state.route = { ...res, a, b, mode: state.mode };
  renderRouteSummary();
  return state.route;
}

function renderRouteSummary() {
  const r = state.route;
  $('#route-summary').textContent = r
    ? `${r.a.label} → ${r.b.label}：${modeIcon()} ${fmtTime(r.seconds)}・${fmtDist(r.meters)}`
    : '';
}

// ---------- 搜尋 ----------
async function settle(jobs) {
  const results = await Promise.allSettled(jobs);
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw results[0].reason;
  const byId = new Map();
  for (const r of ok) for (const p of r.value) if (p.location && !byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()];
}

function fetchNearby(q, origin, radius) {
  if (q.text) return settle([api.searchText(state.key, q.text, origin, radius)]);
  const cat = q.cat;
  const jobs = [];
  if (cat.types) {
    jobs.push(api.searchNearby(state.key, origin, radius, cat.types).catch((err) => {
      if (!cat.fallbackTypes) throw err;
      return api.searchNearby(state.key, origin, radius, cat.fallbackTypes);
    }));
  }
  for (const t of cat.queries || []) jobs.push(api.searchText(state.key, t, origin, radius, serverOpenNow(q)));
  return settle(jobs);
}

function fetchAlong(q, route) {
  const texts = q.text ? [q.text] : (q.cat.queries || q.cat.alongQueries || [q.cat.name]);
  return settle(texts.map((t) => api.searchAlongRoute(state.key, t, route.polyline, route.a, state.mode)));
}

function startSearch(query) {
  state.query = query;
  if (query.cat) applyMealTime(query.cat);
  renderCategories();
  runSearch();
  $('#status').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function runSearch() {
  const q = state.query;
  if (!q) return;
  if (!requireKey()) return;
  const id = ++state.searchId;
  state.places = [];
  state.showCount = 10;
  state.cuisine = null;
  state.kind = null;
  state.routes = { DRIVE: new Map(), WALK: new Map() };
  state.aiPicks = new Map();
  $('#ai-box').hidden = true;
  renderList();

  try {
    if (state.view === 'route') await searchRoute(id, q);
    else await searchNearbyPlaces(id, q);
  } catch (err) {
    if (id !== state.searchId) return;
    setStatus(`搜尋失敗：${err.message}`);
  }
}

function annotateFood(q, places) {
  state.food = q.cat ? !!q.cat.food : places.filter(isFoodPlace).length > places.length / 2;
  if (!state.food) return places.map((p) => ({ ...p, cuisine: placeLabel(p) }));
  return places.map((p) => ({ ...p, cuisine: cuisineLabel(p), kind: shopKind(p) }));
}

async function searchNearbyPlaces(id, q) {
  const origin = state.origin;
  if (!origin) throw new Error('請先定位或輸入地址');
  setStatus(`搜尋${queryName(q)}中…`);
  const raw = await fetchNearby(q, origin, state.radius);
  if (id !== state.searchId) return;
  const places = raw
    .map((p) => {
      const loc = { lat: p.location.latitude, lng: p.location.longitude };
      return { ...p, loc, straight: haversine(origin, loc) };
    })
    .filter((p) => p.straight <= state.radius)
    .sort((a, b) => a.straight - b.straight)
    .slice(0, MAX_CANDIDATES);
  state.places = annotateFood(q, places);
  renderList();
  await ensureRoutes(id);
}

async function searchRoute(id, q) {
  setStatus('規劃路線中…');
  const route = await ensureRoute();
  if (id !== state.searchId) return;
  setStatus(`沿路搜尋${queryName(q)}中…`);
  const raw = await fetchAlong(q, route);
  if (id !== state.searchId) return;
  const places = raw.map((p) => {
    const loc = { lat: p.location.latitude, lng: p.location.longitude };
    const [toPlace, toEnd] = p.legs || [];
    const detour = toPlace && toEnd ? Math.max(0, toPlace.seconds + toEnd.seconds - route.seconds) : null;
    return { ...p, loc, straight: haversine(route.a, loc), toPlace, detour };
  });
  state.places = annotateFood(q, places);
  renderList();
}

// 附近模式：算目前交通方式的路程時間（每種方式只算一次）
async function ensureRoutes(id = state.searchId) {
  const mode = state.mode;
  const cache = state.routes[mode];
  const todo = state.places.filter((p) => !cache.has(p.id));
  if (!todo.length) return renderList();
  setStatus(`計算${modeWord()}時間中…`);
  try {
    const res = await api.routeMatrix(state.key, state.origin, todo.map((p) => p.loc), mode);
    if (id !== state.searchId) return;
    todo.forEach((p, i) => cache.set(p.id, res[i]));
  } catch (err) {
    if (id !== state.searchId) return;
    toast(`路程時間算不出來：${err.message}`);
  }
  renderList();
}

// ---------- 畫面 ----------
function setStatus(text) {
  $('#status').textContent = text;
}

// 餐點類別：自動排除確定沒營業的（營業時間不明的保留）
const autoOpen = () => !!state.query?.cat?.openNow;

// 評分、評論數、營業中、順路繞路上限（不含料理類型）
function baseFiltered() {
  const mustOpen = autoOpen();
  return state.places.filter((p) =>
    (p.rating || 0) >= state.minRating &&
    (p.userRatingCount || 0) >= state.minReviews &&
    (!state.openOnly || openStatus(p) === true) &&
    (!mustOpen || openStatus(p) !== false) &&
    (state.view !== 'route' || p.detour === null || p.detour <= state.maxDetour));
}

function visiblePlaces() {
  const cache = state.routes[state.mode];
  const list = baseFiltered().filter((p) =>
    (!state.cuisine || p.cuisine === state.cuisine) &&
    (!state.kind || p.kind === state.kind));

  const time = (p) => cache.get(p.id)?.seconds ?? Infinity;
  const byRating = (a, b) => (b.rating || 0) - (a.rating || 0) || (b.userRatingCount || 0) - (a.userRatingCount || 0);
  const sorters = {
    distance: (a, b) => (cache.get(a.id)?.meters ?? a.straight) - (cache.get(b.id)?.meters ?? b.straight),
    fastest: (a, b) => time(a) - time(b) || a.straight - b.straight,
    rating: byRating,
    reviews: (a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0),
    detour: (a, b) => (a.detour ?? Infinity) - (b.detour ?? Infinity) || byRating(a, b),
    order: (a, b) => (a.toPlace?.seconds ?? Infinity) - (b.toPlace?.seconds ?? Infinity),
  };
  return list.sort(sorters[state[sortKey()]] || sorters.rating);
}

function travelLine(p) {
  if (state.view === 'route') {
    if (p.detour === null) return `距起點直線 ${fmtDist(p.straight)}`;
    return `繞路 +${fmtTime(p.detour)}・${modeIcon()} ${fmtTime(p.toPlace.seconds)}${clockNote(p)}`;
  }
  const route = state.routes[state.mode].get(p.id);
  if (route) return `${fmtDist(route.meters)} · ${modeIcon()} ${fmtTime(route.seconds)}${clockNote(p)}`;
  return `直線 ${fmtDist(p.straight)}${state.routes[state.mode].has(p.id) ? ` · ${modeIcon()} 無路線` : ''}`;
}

function navUrl(p) {
  const travelmode = state.mode === 'DRIVE' ? 'driving' : 'walking';
  if (state.view === 'route' && state.route) {
    const { a, b } = state.route;
    return `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lng}&destination=${b.lat},${b.lng}`
      + `&waypoints=${p.loc.lat},${p.loc.lng}&travelmode=${travelmode}`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${p.loc.lat},${p.loc.lng}`
    + `&destination_place_id=${encodeURIComponent(p.id)}&travelmode=${travelmode}`;
}

function card(p) {
  const tags = [];
  if (p.cuisine) {
    tags.push(`<span class="tag tag-cuisine">${esc(p.cuisine)}</span>`);
    if (p.kind) tags.push(`<span class="tag ${p.kind === '小吃店' ? 'tag-snack' : 'tag-rest'}">${p.kind}</span>`);
  } else if (p.primaryTypeDisplayName?.text) {
    tags.push(`<span class="tag tag-cuisine">${esc(p.primaryTypeDisplayName.text)}</span>`);
  }
  tags.push(openTag(p));

  const rating = p.rating
    ? `<span class="rating">★ ${p.rating.toFixed(1)}</span><span class="count">(${(p.userRatingCount || 0).toLocaleString()})</span>`
    : '<span class="count">尚無評分</span>';

  const reason = state.aiPicks.get(p.id);

  return `<li class="card${reason ? ' picked' : ''}">
    <div class="card-main">
      <a class="name" href="${esc(p.googleMapsUri)}" target="_blank" rel="noopener">${esc(p.displayName?.text)}</a>
      <div class="meta">${rating}</div>
      <div class="tags">${tags.join('')}</div>
      <div class="travel">${travelLine(p)}</div>
      ${reason ? `<div class="ai-reason">AI：${esc(reason)}</div>` : ''}
      <div class="addr">${esc(p.shortFormattedAddress)}</div>
    </div>
    <a class="nav-btn" href="${esc(navUrl(p))}" target="_blank" rel="noopener" aria-label="導航">導航</a>
  </li>`;
}

// 依目前結果產生類型篩選按鈕；吃的類別另有「餐廳／小吃店」
function renderChips() {
  const bar = $('#chips');
  if (!state.places.length) {
    bar.hidden = true;
    return;
  }
  const base = baseFiltered();
  // 店型的數字依目前選的料理類型算，料理類型的數字依目前選的店型算
  const inCuisine = base.filter((p) => !state.cuisine || p.cuisine === state.cuisine);
  const inKind = base.filter((p) => !state.kind || p.kind === state.kind);
  const tally = (list, key) => {
    const m = new Map();
    for (const p of list) m.set(p[key], (m.get(p[key]) || 0) + 1);
    return m;
  };
  const kinds = tally(inCuisine, 'kind');
  const cuisines = [...tally(inKind, 'cuisine')].sort((a, b) => b[1] - a[1]);
  // 選定的類型數量變 0 時仍保留按鈕，才能點掉
  if (state.cuisine && !cuisines.some(([c]) => c === state.cuisine)) cuisines.unshift([state.cuisine, 0]);

  const chip = (group, val, label, n) => {
    const active = val === null ? !state.cuisine && !state.kind : state[group] === val;
    if (!n && !active && val !== null) return '';
    return `<button class="chip${active ? ' active' : ''}" data-group="${group}" data-val="${esc(val ?? '')}">${esc(label)} <b>${n}</b></button>`;
  };
  // 非吃的類別只有一種類型時，按鈕沒意義
  if (!state.food && cuisines.length < 2 && !state.cuisine) {
    bar.hidden = true;
    return;
  }
  bar.innerHTML = [
    chip('all', null, '全部', base.length),
    ...(state.food ? [...['小吃店', '餐廳'].map((k) => chip('kind', k, k, kinds.get(k) || 0)), '<span class="chip-sep"></span>'] : []),
    ...cuisines.map(([c, n]) => chip('cuisine', c, c, n)),
  ].join('');
  bar.hidden = false;
}

function renderList() {
  const list = $('#results');
  const more = $('#more');
  renderChips();
  if (!state.query) {
    list.innerHTML = '';
    more.hidden = true;
    $('#ai-pick').hidden = true;
    setStatus(state.view === 'route' ? '輸入 A、B 點，再選類別或打關鍵字' : '選一個類別或打關鍵字開始找');
    return;
  }
  const all = visiblePlaces();
  const shown = all.slice(0, state.showCount);
  list.innerHTML = shown.map(card).join('');
  more.hidden = all.length <= state.showCount;
  $('#ai-pick').hidden = !all.length;
  if (state.places.length && !all.length) {
    setStatus(state.cuisine || state.kind
      ? '這個類型沒有符合的，點「全部」看其他'
      : `沒有符合條件的地點，試著放寬評分或${state.view === 'route' ? '繞路時間' : '距離'}`);
  } else if (state.places.length) {
    const scope = state.view === 'route' ? `繞路 ${state.maxDetour / 60} 分內` : `${fmtDist(state.radius)}內`;
    let openNote = '';
    if (autoOpen()) {
      openNote = `，已排除${isArrive() ? `${whenWord()} ` : '抵達時'}沒營業的`;
    }
    setStatus(`${queryName(state.query)}：符合 ${all.length} 間，顯示 ${shown.length} 間（${scope}${openNote}）`);
  }
}

function renderCategories() {
  const activeId = state.query?.cat?.id;
  $('#categories').innerHTML = CATEGORIES.map((c) => `
    <button class="cat${activeId === c.id ? ' active' : ''}" data-id="${c.id}">
      <span class="cat-icon">${c.icon}</span><span>${c.name}</span>
    </button>`).join('');
}

function syncControls() {
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  const route = state.view === 'route';
  $('#nearby-panel').hidden = route;
  $('#route-form').hidden = !route;
  $('#search-ui').hidden = !isSearchView();
  $('#plan-ui').hidden = isSearchView();
  $('#radius').hidden = route;
  $('#detour').hidden = !route;
  $('#sort').innerHTML = SORTS[route ? 'route' : 'nearby'].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  $('#sort').value = state[sortKey()];
  $('#radius').value = String(state.radius);
  $('#detour').value = String(state.maxDetour);
  $('#min-rating').value = String(state.minRating);
  $('#min-reviews').value = String(state.minReviews);
  $('#open-only').checked = state.openOnly;
}

// ---------- 設定 ----------
function openSettings() {
  $('#api-key').value = state.key;
  $('#claude-key').value = state.claudeKey;
  $('#settings').showModal();
}

// ---------- 設定碼：把金鑰與同行成員打包，方便傳給家人 ----------
const SETUP_PREFIX = 'TT1:';

function encodeSetup() {
  const json = JSON.stringify({ key: state.key, claudeKey: state.claudeKey, party: state.party });
  const bin = String.fromCharCode(...new TextEncoder().encode(json));
  return SETUP_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 成功回傳 true；格式不對回傳 false
function applySetup(code) {
  const raw = code.trim();
  if (!raw.startsWith(SETUP_PREFIX)) return false;
  try {
    const b64 = raw.slice(SETUP_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof data.key === 'string') state.key = data.key;
    if (typeof data.claudeKey === 'string') state.claudeKey = data.claudeKey;
    if (data.party) state.party = { ...state.party, ...data.party };
    savePrefs();
    syncPartyButton();
    return true;
  } catch {
    return false;
  }
}

async function shareSetup() {
  if (!state.key) return toast('先儲存 Google 金鑰，才能分享設定');
  const code = encodeSetup();
  const text = `旅遊玩意設定碼（打開 App 點 ⚙️，貼到「設定碼」再按儲存）：\n${code}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else {
      await navigator.clipboard.writeText(code);
      toast('設定碼已複製，貼到 LINE 傳給家人');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') toast('分享失敗，請再試一次');
  }
}

function requireClaudeKey() {
  if (MOCK || state.claudeKey) return true;
  openSettings();
  toast('請先輸入 Claude API 金鑰');
  return false;
}

// ---------- 同行成員 ----------
let partyDraft = null;

function partyShort(party) {
  const n = party.adults + party.seniors + party.kids.length + party.babies.length;
  return n ? `${n} 人` : '同行';
}

function renderPartyForm() {
  for (const el of document.querySelectorAll('#party .stepper')) {
    el.querySelector('b').textContent = partyDraft[el.dataset.field];
  }
  const ageItem = (group, age, i) => {
    const ages = group === 'kids' ? [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [0, 1, 2];
    const opts = ages.map((a) => `<option value="${a}"${a === age ? ' selected' : ''}>${a === 0 ? '未滿 1 歲' : `${a} 歲`}</option>`).join('');
    return `<span class="age-item"><select data-group="${group}" data-i="${i}" aria-label="年齡">${opts}</select>`
      + `<button type="button" data-remove="${group}" data-i="${i}" aria-label="移除">×</button></span>`;
  };
  for (const list of document.querySelectorAll('#party .age-list')) {
    const group = list.dataset.list;
    list.innerHTML = partyDraft[group].map((age, i) => ageItem(group, age, i)).join('');
  }
  $('#party-note').value = partyDraft.note;
}

function openParty() {
  partyDraft = structuredClone(state.party);
  renderPartyForm();
  $('#party').showModal();
}

function syncPartyButton() {
  $('#party-summary').textContent = partyShort(state.party);
}

// ---------- AI 幫我挑 ----------
// 送給 AI 的候選地點，只留判斷需要的欄位
function placeForAi(p) {
  const route = state.routes[state.mode].get(p.id);
  return {
    id: p.id,
    名稱: p.displayName?.text,
    評分: p.rating ?? null,
    評論數: p.userRatingCount ?? 0,
    類型: p.kind ? `${p.cuisine}／${p.kind}` : p.cuisine || p.primaryTypeDisplayName?.text,
    營業: { true: '抵達時有營業', false: '抵達時沒營業', undefined: '不明' }[openStatus(p)],
    ...(state.view === 'route'
      ? { 繞路分鐘: p.detour === null ? null : Math.round(p.detour / 60) }
      : { 距離公尺: Math.round(route?.meters ?? p.straight), [`${modeWord()}分鐘`]: route ? Math.round(route.seconds / 60) : null }),
    地址: p.shortFormattedAddress,
  };
}

function searchContext() {
  const when = !state.when ? '現在出發' : `${isArrive() ? '預計' : ''}${whenWord()}${isArrive() ? ' 抵達' : ' 出發'}`;
  const where = state.view === 'route' && state.route
    ? `順路：從 ${state.route.a.label} 到 ${state.route.b.label}，候選都是沿路的地點`
    : `位置：${state.origin?.label?.replace(/^\S+\s/, '') || '未知'} 附近`;
  return `正在找：${queryName(state.query)}\n${where}\n交通：${modeWord()}\n時間：${when}（現在是 ${new Date().toLocaleString('zh-TW', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}）`;
}

async function aiPick() {
  if (!requireClaudeKey()) return;
  const candidates = visiblePlaces().slice(0, 20);
  if (!candidates.length) return;
  const btn = $('#ai-pick');
  const box = $('#ai-box');
  btn.disabled = true;
  btn.textContent = 'AI 思考中…';
  try {
    const res = await ai.recommend({
      apiKey: state.claudeKey,
      party: state.party,
      context: searchContext(),
      places: candidates.map(placeForAi),
    });
    const byId = new Map(candidates.map((p) => [p.id, p]));
    const picks = res.picks.filter((x) => byId.has(x.id));
    state.aiPicks = new Map(picks.map((x) => [x.id, x.reason]));
    box.innerHTML = `<div>${esc(res.summary)}</div>`
      + `<ol>${picks.map((x) => `<li>${esc(byId.get(x.id).displayName?.text)}</li>`).join('')}</ol>`
      + (res.tips ? `<p class="tip">${esc(res.tips)}</p>` : '');
    box.hidden = false;
    renderList();
  } catch (err) {
    toast(`AI 推薦失敗：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 幫我挑';
  }
}

// ---------- AI 行程 ----------
// 給 AI 的搜尋工具：用 Google 搜尋真實地點並整理成精簡資料
async function searchForPlan(center, date, query, near) {
  const base = near ? await geocodeCached(near) : center;
  const raw = await api.searchText(state.key, query, base, 5000);
  return raw.filter((p) => p.location).slice(0, 8).map((p) => {
    const loc = { lat: p.location.latitude, lng: p.location.longitude };
    return {
      name: p.displayName?.text,
      rating: p.rating ?? null,
      reviews: p.userRatingCount ?? 0,
      type: p.primaryTypeDisplayName?.text || null,
      address: p.shortFormattedAddress,
      km_from_start: Math.round(haversine(center, loc) / 100) / 10,
      hours_that_day: hoursOn(p, date),
      mapsUrl: p.googleMapsUri,
    };
  });
}

// 簡易排版：## 標題、- 清單、**粗體**，並把查過的地點名稱變成地圖連結
function renderPlan(text, places) {
  const names = [...places.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  const inline = (s) => {
    let html = esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    for (const n of names) {
      const safe = esc(n);
      if (html.includes(safe)) html = html.split(safe).join(`<a href="${esc(places.get(n))}" target="_blank" rel="noopener">${safe}</a>`);
    }
    return html;
  };
  let out = '';
  let inList = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    const isItem = /^[-•]\s+/.test(t);
    if (inList && !isItem) { out += '</ul>'; inList = false; }
    if (!t) continue;
    if (/^#{1,4}\s/.test(t)) out += `<h3>${inline(t.replace(/^#+\s*/, ''))}</h3>`;
    else if (isItem) {
      if (!inList) { out += '<ul>'; inList = true; }
      out += `<li>${inline(t.replace(/^[-•]\s+/, ''))}</li>`;
    } else out += `<p>${inline(t)}</p>`;
  }
  if (inList) out += '</ul>';
  return out;
}

async function planTrip(e) {
  e.preventDefault();
  if (!requireKey() || !requireClaudeKey()) return;
  const center = state.origin;
  if (!center) return toast('請先定位或輸入出發地址');
  const request = $('#plan-request').value.trim();
  const day = Number($('#plan-day').value);
  const start = $('#plan-start').value || '10:00';
  const end = $('#plan-end').value || '18:00';
  const date = new Date();
  date.setDate(date.getDate() + day);
  const dateText = date.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'long' });

  const prompt = [
    `出發地：${center.label.replace(/^\S+\s/, '')}（緯度 ${center.lat.toFixed(5)}，經度 ${center.lng.toFixed(5)}）`,
    `日期：${dateText}，${start} 到 ${end}`,
    `交通：${modeWord()}`,
    `同行成員：${ai.partyText(state.party)}`,
    `需求：${request || '沒有特別需求，請安排輕鬆好玩的一天'}`,
  ].join('\n');

  const btn = $('#plan-go');
  const out = $('#plan-output');
  btn.disabled = true;
  out.hidden = false;
  out.classList.remove('done');
  out.textContent = '';
  try {
    const res = await ai.planTrip({
      apiKey: state.claudeKey,
      prompt,
      searchPlaces: (query, near) => searchForPlan(center, date, query, near),
      onTurn: () => { out.textContent = ''; },
      onText: (t) => { out.textContent += t; $('#plan-status').textContent = 'AI 撰寫中…'; },
      onStatus: (s) => { $('#plan-status').textContent = s; },
    });
    out.innerHTML = renderPlan(res.text, res.places);
    out.classList.add('done');
    $('#plan-status').textContent = `完成！點地點名稱可以開 Google 地圖（查了 ${res.places.size} 個地點）`;
  } catch (err) {
    $('#plan-status').textContent = `規劃失敗：${err.message}`;
    if (!out.textContent) out.hidden = true;
  } finally {
    btn.disabled = false;
  }
}

// ---------- 事件 ----------
function bind() {
  $('#locate').addEventListener('click', locateMe);
  $('#address-form').addEventListener('submit', searchAddress);

  document.querySelectorAll('.view-btn').forEach((b) => b.addEventListener('click', () => {
    if (state.view === b.dataset.view) return;
    state.view = b.dataset.view;
    savePrefs();
    syncControls();
    if (state.view === 'plan') return;
    state.places = [];
    renderList();
    if (state.view === 'route' && !$('#route-b').value.trim()) {
      // 保留目前的類別／關鍵字，輸入 B 後按 Enter 就沿路搜尋
      if (state.query) setStatus(`輸入終點 B 後按 Enter，沿路找${queryName(state.query)}`);
      $('#route-b').focus();
    } else {
      runSearch();
    }
  }));

  $('#route-form').addEventListener('submit', (e) => {
    e.preventDefault();
    document.activeElement?.blur();
    if (state.query) runSearch();
    else setStatus('選一個類別或打關鍵字，沿路幫你找');
  });

  $('#kw-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#kw').value.trim();
    if (!text) return;
    $('#kw').blur();
    startSearch({ text });
  });

  $('#categories').addEventListener('click', (e) => {
    const btn = e.target.closest('.cat');
    if (!btn) return;
    $('#kw').value = '';
    startSearch({ cat: CATEGORIES.find((c) => c.id === btn.dataset.id) });
  });

  document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => {
    if (state.mode === b.dataset.mode) return;
    state.mode = b.dataset.mode;
    savePrefs();
    syncControls();
    if (state.view === 'route') {
      // 順路的繞路時間跟交通方式有關，要重搜
      if (state.query) runSearch();
    } else {
      renderList();
      if (state.places.length) ensureRoutes();
    }
  }));

  $('#radius').addEventListener('change', (e) => {
    state.radius = Number(e.target.value);
    savePrefs();
    runSearch();
  });
  const onFilter = () => {
    state.maxDetour = Number($('#detour').value);
    state.minRating = Number($('#min-rating').value);
    state.minReviews = Number($('#min-reviews').value);
    state[sortKey()] = $('#sort').value;
    state.openOnly = $('#open-only').checked;
    state.showCount = 10;
    savePrefs();
    renderList();
  };
  ['#detour', '#min-rating', '#min-reviews', '#sort', '#open-only'].forEach((s) => $(s).addEventListener('change', onFilter));

  const onWhen = () => {
    const type = $('#when-type').value;
    if (!type) state.when = null;
    else {
      const fallback = state.when?.time || fmtClock(new Date(Date.now() + 3600e3)).replace(/:\d\d$/, ':00');
      state.when = { type, day: Number($('#when-day').value), time: $('#when-time').value || fallback };
    }
    syncWhen();
    // 「現在＋附近」的結果被 Google 預先過濾過，換時間要重搜才拿得到其他店
    if (state.query?.cat?.openNow && state.view === 'nearby') runSearch();
    else renderList();
  };
  $('#when-type').addEventListener('change', onWhen);
  $('#when-day').addEventListener('change', onWhen);
  $('#when-time').addEventListener('change', onWhen);

  $('#chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const { group, val } = btn.dataset;
    if (group === 'all') {
      state.cuisine = null;
      state.kind = null;
    } else {
      state[group] = state[group] === val ? null : val; // 再點一次取消
    }
    state.showCount = 10;
    renderList();
  });

  $('#more').addEventListener('click', () => {
    state.showCount += 10;
    renderList();
  });

  $('#open-settings').addEventListener('click', openSettings);
  $('#settings-form').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    const code = $('#setup-code').value.trim();
    $('#setup-code').value = '';
    if (code) {
      toast(applySetup(code) ? '設定碼已套用，可以開始用了' : '設定碼不正確，請整段重新複製');
      return;
    }
    state.key = $('#api-key').value.trim();
    state.claudeKey = $('#claude-key').value.trim();
    savePrefs();
    toast('設定已儲存');
  });
  $('#share-setup').addEventListener('click', shareSetup);

  $('#ai-pick').addEventListener('click', aiPick);
  $('#plan-ui').addEventListener('submit', planTrip);

  $('#open-party').addEventListener('click', openParty);
  $('#party-form').addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    if (step) {
      const field = step.parentElement.dataset.field;
      partyDraft[field] = Math.max(0, Math.min(20, partyDraft[field] + Number(step.dataset.step)));
      return renderPartyForm();
    }
    const add = e.target.closest('[data-add]');
    if (add) {
      partyDraft[add.dataset.add].push(add.dataset.add === 'kids' ? 6 : 1);
      return renderPartyForm();
    }
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      partyDraft[remove.dataset.remove].splice(Number(remove.dataset.i), 1);
      renderPartyForm();
    }
  });
  $('#party-form').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-group]');
    if (sel) partyDraft[sel.dataset.group][Number(sel.dataset.i)] = Number(sel.value);
  });
  $('#party-form').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    partyDraft.note = $('#party-note').value.trim();
    state.party = partyDraft;
    savePrefs();
    syncPartyButton();
    toast(`同行成員已更新：${ai.partyText(state.party)}`);
  });
}

function init() {
  if (MOCK) document.body.classList.add('mock');
  renderCategories();
  syncControls();
  syncWhen();
  syncPartyButton();
  bind();
  renderList();
  locateMe();
  if ('serviceWorker' in navigator && !MOCK) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
