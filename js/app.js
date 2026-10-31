import { CATEGORIES } from './categories.js';
import { cuisineLabel, shopKind } from './classify.js';
import * as realApi from './api.js';
import * as mockApi from './mock.js';

const MOCK = new URLSearchParams(location.search).has('mock');
const api = MOCK ? mockApi : realApi;
const MAX_CANDIDATES = 25; // 送去算路程的最多筆數（依直線距離取最近）

const $ = (sel) => document.querySelector(sel);

// ---------- 偏好設定（只存在這台手機） ----------
const PREF_KEY = 'travel-toy-prefs';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
}
function savePrefs() {
  const { key, mode, radius, minRating, minReviews, openOnly, sort } = state;
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ key, mode, radius, minRating, minReviews, openOnly, sort }));
  } catch { /* 無痕模式等情況存不了，略過 */ }
}

const state = {
  key: '', mode: 'DRIVE', radius: 3000, minRating: 0, minReviews: 0, openOnly: false, sort: 'distance',
  ...loadPrefs(),
  origin: null,
  category: null,
  places: [],
  routes: { DRIVE: new Map(), WALK: new Map() },
  showCount: 10,
  searchId: 0,
};

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

// ---------- 定位 ----------
function setOrigin(origin) {
  state.origin = origin;
  state.routes = { DRIVE: new Map(), WALK: new Map() };
  $('#origin-label').textContent = origin.label;
  if (state.category) runSearch();
}

function locateMe() {
  if (!navigator.geolocation) return toast('這個瀏覽器不支援定位');
  $('#origin-label').textContent = '定位中…';
  navigator.geolocation.getCurrentPosition(
    (pos) => setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: '📍 目前位置' }),
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

// ---------- 搜尋 ----------
async function fetchCategory(cat, origin, radius) {
  const jobs = [];
  if (cat.types) {
    jobs.push(api.searchNearby(state.key, origin, radius, cat.types).catch((err) => {
      if (!cat.fallbackTypes) throw err;
      return api.searchNearby(state.key, origin, radius, cat.fallbackTypes);
    }));
  }
  for (const q of cat.queries || []) jobs.push(api.searchText(state.key, q, origin, radius));

  const results = await Promise.allSettled(jobs);
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw results[0].reason;

  const byId = new Map();
  for (const r of ok) for (const p of r.value) if (p.location && !byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()];
}

async function runSearch() {
  const cat = state.category;
  if (!cat) return;
  if (!state.origin) return toast('請先定位或輸入地址');
  if (!requireKey()) return;

  const id = ++state.searchId;
  const origin = state.origin;
  state.places = [];
  state.showCount = 10;
  state.routes = { DRIVE: new Map(), WALK: new Map() };
  setStatus(`搜尋「${cat.name}」中…`);
  renderList();

  try {
    const raw = await fetchCategory(cat, origin, state.radius);
    if (id !== state.searchId) return;
    state.places = raw
      .map((p) => {
        const loc = { lat: p.location.latitude, lng: p.location.longitude };
        return { ...p, loc, straight: haversine(origin, loc) };
      })
      .filter((p) => p.straight <= state.radius)
      .sort((a, b) => a.straight - b.straight)
      .slice(0, MAX_CANDIDATES);
    renderList();
    await ensureRoutes(id);
  } catch (err) {
    if (id !== state.searchId) return;
    setStatus(`搜尋失敗：${err.message}`);
  }
}

// 算目前交通方式的路程時間（每種方式只算一次）
async function ensureRoutes(id = state.searchId) {
  const mode = state.mode;
  const cache = state.routes[mode];
  const todo = state.places.filter((p) => !cache.has(p.id));
  if (!todo.length) return renderList();
  setStatus(`計算${mode === 'DRIVE' ? '開車' : '走路'}時間中…`);
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

function visiblePlaces() {
  const cache = state.routes[state.mode];
  const list = state.places.filter((p) =>
    (p.rating || 0) >= state.minRating &&
    (p.userRatingCount || 0) >= state.minReviews &&
    (!state.openOnly || p.currentOpeningHours?.openNow === true));

  const time = (p) => cache.get(p.id)?.seconds ?? Infinity;
  const sorters = {
    distance: (a, b) => (cache.get(a.id)?.meters ?? a.straight) - (cache.get(b.id)?.meters ?? b.straight),
    fastest: (a, b) => time(a) - time(b) || a.straight - b.straight,
    rating: (a, b) => (b.rating || 0) - (a.rating || 0) || (b.userRatingCount || 0) - (a.userRatingCount || 0),
    reviews: (a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0),
  };
  return list.sort(sorters[state.sort]);
}

function card(p) {
  const cat = state.category;
  const route = state.routes[state.mode].get(p.id);
  const modeWord = state.mode === 'DRIVE' ? '🚗' : '🚶';
  const open = p.currentOpeningHours?.openNow;
  const tags = [];
  if (cat.food) {
    tags.push(`<span class="tag tag-cuisine">${esc(cuisineLabel(p))}</span>`);
    const kind = shopKind(p);
    tags.push(`<span class="tag ${kind === '小吃店' ? 'tag-snack' : 'tag-rest'}">${kind}</span>`);
  } else if (p.primaryTypeDisplayName?.text) {
    tags.push(`<span class="tag tag-cuisine">${esc(p.primaryTypeDisplayName.text)}</span>`);
  }
  if (open === true) tags.push('<span class="tag tag-open">營業中</span>');
  if (open === false) tags.push('<span class="tag tag-closed">休息中</span>');

  const rating = p.rating
    ? `<span class="rating">★ ${p.rating.toFixed(1)}</span><span class="count">(${(p.userRatingCount || 0).toLocaleString()})</span>`
    : '<span class="count">尚無評分</span>';
  const travel = route
    ? `${fmtDist(route.meters)} · ${modeWord} ${fmtTime(route.seconds)}`
    : `直線 ${fmtDist(p.straight)}${state.routes[state.mode].has(p.id) ? ` · ${modeWord} 無路線` : ''}`;
  const nav = `https://www.google.com/maps/dir/?api=1&destination=${p.loc.lat},${p.loc.lng}`
    + `&destination_place_id=${encodeURIComponent(p.id)}&travelmode=${state.mode === 'DRIVE' ? 'driving' : 'walking'}`;

  return `<li class="card">
    <div class="card-main">
      <a class="name" href="${esc(p.googleMapsUri)}" target="_blank" rel="noopener">${esc(p.displayName?.text)}</a>
      <div class="meta">${rating}</div>
      <div class="tags">${tags.join('')}</div>
      <div class="travel">${travel}</div>
      <div class="addr">${esc(p.shortFormattedAddress)}</div>
    </div>
    <a class="nav-btn" href="${nav}" target="_blank" rel="noopener" aria-label="導航">導航</a>
  </li>`;
}

function renderList() {
  const list = $('#results');
  const more = $('#more');
  if (!state.category) {
    list.innerHTML = '';
    more.hidden = true;
    setStatus('選一個類別開始找');
    return;
  }
  const all = visiblePlaces();
  const shown = all.slice(0, state.showCount);
  list.innerHTML = shown.map(card).join('');
  more.hidden = all.length <= state.showCount;
  if (state.places.length && !all.length) setStatus('沒有符合條件的地點，試著放寬評分或距離');
  else if (state.places.length) {
    setStatus(`${state.category.name}：符合 ${all.length} 間，顯示 ${shown.length} 間（${fmtDist(state.radius)}內）`);
  }
}

function renderCategories() {
  $('#categories').innerHTML = CATEGORIES.map((c) => `
    <button class="cat${state.category?.id === c.id ? ' active' : ''}" data-id="${c.id}">
      <span class="cat-icon">${c.icon}</span><span>${c.name}</span>
    </button>`).join('');
}

function syncControls() {
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  $('#radius').value = String(state.radius);
  $('#min-rating').value = String(state.minRating);
  $('#min-reviews').value = String(state.minReviews);
  $('#sort').value = state.sort;
  $('#open-only').checked = state.openOnly;
}

// ---------- 設定 ----------
function openSettings() {
  $('#api-key').value = state.key;
  $('#settings').showModal();
}

// ---------- 事件 ----------
function bind() {
  $('#locate').addEventListener('click', locateMe);
  $('#address-form').addEventListener('submit', searchAddress);

  $('#categories').addEventListener('click', (e) => {
    const btn = e.target.closest('.cat');
    if (!btn) return;
    state.category = CATEGORIES.find((c) => c.id === btn.dataset.id);
    renderCategories();
    runSearch();
  });

  document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    savePrefs();
    syncControls();
    renderList();
    if (state.places.length) ensureRoutes();
  }));

  $('#radius').addEventListener('change', (e) => {
    state.radius = Number(e.target.value);
    savePrefs();
    runSearch();
  });
  const onFilter = () => {
    state.minRating = Number($('#min-rating').value);
    state.minReviews = Number($('#min-reviews').value);
    state.sort = $('#sort').value;
    state.openOnly = $('#open-only').checked;
    state.showCount = 10;
    savePrefs();
    renderList();
  };
  ['#min-rating', '#min-reviews', '#sort', '#open-only'].forEach((s) => $(s).addEventListener('change', onFilter));

  $('#more').addEventListener('click', () => {
    state.showCount += 10;
    renderList();
  });

  $('#open-settings').addEventListener('click', openSettings);
  $('#settings-form').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    state.key = $('#api-key').value.trim();
    savePrefs();
    toast(state.key ? '金鑰已儲存' : '金鑰已清除');
  });
}

function init() {
  if (MOCK) document.body.classList.add('mock');
  renderCategories();
  syncControls();
  bind();
  renderList();
  locateMe();
  if ('serviceWorker' in navigator && !MOCK) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
