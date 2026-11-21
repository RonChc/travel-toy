// 👥 群組：加入群組、成員位置、找人（推播／App 內提示）、回覆位置＋樓層＋照片
// 與群組後台（server/）溝通；畫面一律用 textContent／DOM 建立，不用 innerHTML 塞使用者資料。
import { gateway, setGateway } from './gateway.js';
import qrcode from './vendor/qrcode.mjs';

const STORE_KEY = 'travel-toy-group';
const SERVER_KEY = 'travel-toy-group-server';
const EMOJIS = ['😀', '😎', '🥳', '🤠', '🐶', '🐱', '🐰', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐵', '🦄', '🐥', '🌻', '🍀', '🍎', '🍓', '⚽', '🎈', '🚗', '⭐'];
const FLOORS = ['B3F', 'B2F', 'B1F', ...Array.from({ length: 10 }, (_, i) => `${i + 1}F`)];
const POLL_MS = 5000;
const POLL_HIDDEN_MS = 30000;
const ID_RE = /^[0-9a-f]{6,40}$/;

const $ = (s) => document.querySelector(s);
const ENV = { toast: () => {}, getHere: () => null, onChange: () => {}, openSettings: () => {}, fmtDist: String, haversine: () => 0 };

// ---------- 小工具 ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const clear = (el) => el.replaceChildren();

// 用後台的時間算「幾分鐘前」，手機時鐘不準也不會錯
const serverNow = () => (state ? state.serverTime + (Date.now() - state.fetchedAt) : Date.now());

function fmtAgo(t, now = serverNow()) {
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return '剛剛';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  return hr < 24 ? `${hr} 小時前` : `${Math.floor(hr / 24)} 天前`;
}

function fmtExpiry(t) {
  const left = Math.max(0, t - serverNow());
  const days = Math.floor(left / 864e5);
  const hours = Math.floor((left % 864e5) / 36e5);
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 自動解散（還剩${days ? ` ${days} 天` : ''} ${hours} 小時）`;
}

// ---------- 本機儲存 ----------
let me = null; // { server, token, memberId, groupId, groupName, isAdmin, tier, inviteCode, expiresAt }
function loadMe() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { return null; }
}
function saveMe() {
  try {
    if (me) localStorage.setItem(STORE_KEY, JSON.stringify(me));
    else localStorage.removeItem(STORE_KEY);
  } catch { /* 無痕模式存不了就略過 */ }
}

export function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `${/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(s) ? 'http' : 'https'}://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null; // 位置與權杖不能走明碼
  return u.origin;
}

export const getServer = () => me?.server || localStorage.getItem(SERVER_KEY) || '';
export function setServer(input) {
  const s = normalizeServer(input);
  if (s === null) return false;
  try { localStorage.setItem(SERVER_KEY, s); } catch { /* 略過 */ }
  renderOff();
  return true;
}

// ---------- 對外：給 app.js 判斷金鑰要走哪裡 ----------
export const isJoined = () => !!me;
export const isFriend = () => !!me && me.tier === 'friend';
export const canUseProxy = () => !!me && me.tier === 'family';

function applyGateway() {
  if (me) setGateway(me.server, me.token);
  else setGateway('', '');
}

// ---------- 呼叫後台 ----------
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function call(method, path, { body, raw, type, auth = true, server } = {}) {
  const base = server || me?.server;
  if (!base) throw new ApiError(0, 'no_server', '請先到 ⚙️ 設定填入群組伺服器網址');
  const headers = {};
  if (auth && me) headers.Authorization = `Bearer ${me.token}`;
  let payload;
  if (raw !== undefined) { headers['Content-Type'] = type; payload = raw; } else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'network', '連不上群組伺服器，請確認網址或網路');
  }
  if (res.status === 401 && auth && me) { leaveLocal('群組已解散、到期，或你已被移出群組'); }
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new ApiError(res.status, j?.error || 'error', j?.message || `錯誤 ${res.status}`);
  }
  return res;
}
const callJson = async (...a) => (await call(...a)).json();

// ---------- 加入／建立／離開 ----------
function leaveLocal(msg) {
  stopPolling();
  me = null;
  state = null;
  lastKey = '';
  saveMe();
  applyGateway();
  if (msg) ENV.toast(msg);
  render();
  ENV.onChange();
}

function emojiPicker(container, selected) {
  clear(container);
  EMOJIS.forEach((e, i) => {
    const id = `emo-${container.id}-${i}`;
    container.append(
      h('input', { type: 'radio', name: `emoji-${container.id}`, id, value: e, class: 'emoji-radio', ...(e === selected ? { checked: true } : {}) }),
      h('label', { for: id, class: 'emoji-label' }, e),
    );
  });
}
const pickedEmoji = (container) => container.querySelector('input:checked')?.value;

function openCreate() {
  const server = getServer();
  if (!server) { ENV.toast('請先設定群組伺服器網址'); return ENV.openSettings(); }
  $('#gc-server').textContent = `伺服器：${new URL(server).host}`;
  emojiPicker($('#gc-emoji'), EMOJIS[1]);
  $('#gc-error').textContent = '';
  $('#group-create-dialog').showModal();
}

async function submitCreate(e) {
  e.preventDefault();
  const btn = $('#gc-submit');
  btn.disabled = true;
  $('#gc-error').textContent = '';
  try {
    const server = getServer();
    const r = await callJson('POST', '/api/groups', {
      auth: false, server,
      body: { name: $('#gc-name').value, createCode: $('#gc-code').value, memberName: $('#gc-me').value, emoji: pickedEmoji($('#gc-emoji')) },
    });
    me = { server, token: r.token, memberId: r.memberId, groupId: r.groupId, groupName: $('#gc-name').value.trim(), isAdmin: true, tier: 'family', inviteCode: r.inviteCode, expiresAt: r.expiresAt };
    $('#gc-code').value = '';
    saveMe();
    applyGateway();
    $('#group-create-dialog').close();
    afterJoin('群組建立好了，把邀請連結傳給同行的人');
  } catch (err) {
    $('#gc-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

let pendingJoin = null; // { code, server }
async function openJoin({ code, server }) {
  if (me) return ENV.toast('你已經在一個群組裡了，要加入新的請先離開目前的群組');
  const norm = normalizeServer(server || getServer());
  if (!norm) { ENV.toast('邀請連結的伺服器網址不正確'); return; }
  try {
    const info = await callJson('POST', '/api/invite/info', { auth: false, server: norm, body: { inviteCode: code } });
    pendingJoin = { code, server: norm };
    $('#gj-title').textContent = `加入「${info.groupName}」`;
    $('#gj-server').textContent = `伺服器：${new URL(norm).host}（目前 ${info.memberCount} 人）。只加入認識的人傳來的連結。`;
    emojiPicker($('#gj-emoji'), EMOJIS[Math.floor(Math.random() * EMOJIS.length)]);
    $('#gj-error').textContent = '';
    $('#group-join-dialog').showModal();
  } catch (err) {
    ENV.toast(err.status === 404 ? '邀請連結已失效，請向管理員重新要一個' : err.message);
  }
}

async function submitJoin(e) {
  e.preventDefault();
  const btn = $('#gj-submit');
  btn.disabled = true;
  $('#gj-error').textContent = '';
  try {
    const { code, server } = pendingJoin;
    const r = await callJson('POST', '/api/join', { auth: false, server, body: { inviteCode: code, name: $('#gj-name').value, emoji: pickedEmoji($('#gj-emoji')) } });
    me = { server, token: r.token, memberId: r.memberId, groupId: r.groupId, groupName: r.groupName, isAdmin: false, tier: r.tier, inviteCode: '', expiresAt: r.expiresAt };
    try { localStorage.setItem(SERVER_KEY, server); } catch { /* 略過 */ }
    saveMe();
    applyGateway();
    $('#group-join-dialog').close();
    afterJoin(`已加入「${r.groupName}」`);
  } catch (err) {
    $('#gj-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function afterJoin(msg) {
  ENV.toast(msg);
  state = null;
  render();
  startPolling();
  refresh();
  ENV.onChange();
}

// 貼上邀請連結加入（連結裡有 join 與 server 參數）
function parseInvite(text) {
  try {
    const u = new URL(text.trim());
    const p = new URLSearchParams(u.hash.replace(/^#/, ''));
    const code = p.get('join');
    if (code) return { code, server: p.get('server') || '' };
  } catch { /* 不是網址 */ }
  return null;
}

function promptPasteInvite() {
  $('#gp-text').value = '';
  $('#gp-error').textContent = '';
  $('#group-paste-dialog').showModal();
}

// ---------- 狀態輪詢 ----------
let state = null;
let timer = null;
let lastKey = '';
const shownAsks = new Set(); // 這次開 App 已經跳過視窗的找人請求
const shownReplies = new Set();
let refreshing = false;

function startPolling() {
  stopPolling();
  if (!me) return;
  const tick = () => {
    refresh();
    timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
  };
  timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
}
function stopPolling() { clearTimeout(timer); timer = null; }

export async function refresh() {
  if (!me || refreshing) return;
  refreshing = true;
  try {
    const s = await callJson('GET', '/api/state');
    state = s;
    state.fetchedAt = Date.now();
    let changed = false;
    if (s.me.tier !== me.tier || s.group.name !== me.groupName || s.group.expiresAt !== me.expiresAt) {
      me = { ...me, tier: s.me.tier, groupName: s.group.name, expiresAt: s.group.expiresAt };
      saveMe();
      changed = true;
    }
    setNetError('');
    render();
    if (changed) ENV.onChange();
    handleIncoming(s);
  } catch (err) {
    if (me && err.status !== 401) setNetError(err.message);
  } finally {
    refreshing = false;
  }
}

function setNetError(msg) {
  const el = $('#group-status');
  if (el) el.textContent = msg;
}

// 後台回「朋友不能用代轉」時：馬上把本機的身分改成朋友（畫面提示自己輸入金鑰）
gateway.onDenied = () => {
  if (me && me.tier !== 'friend') {
    me = { ...me, tier: 'friend' };
    saveMe();
    render();
    ENV.onChange();
  }
  refresh();
};

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// ---------- 提示音（Web Audio，第一次互動後才能播） ----------
let audio = null;
function unlockAudio() {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* 不支援就沒有聲音 */ }
}
['pointerdown', 'keydown', 'touchend'].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));

export function playAlert() {
  // 瀏覽器規定：使用者碰過畫面之後才能震動，否則會在主控台報錯
  try { if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([250, 120, 250, 120, 250]); } catch { /* 略過 */ }
  if (!audio || audio.state !== 'running') return false;
  const t0 = audio.currentTime;
  [0, 0.32, 0.64].forEach((dt, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = i === 2 ? 1175 : 880;
    gain.gain.setValueAtTime(0.0001, t0 + dt);
    gain.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.26);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0 + dt);
    osc.stop(t0 + dt + 0.3);
  });
  return true;
}

// ---------- 收到找人／回覆 ----------
const askQueue = [];
function handleIncoming(s) {
  for (const a of s.asks) {
    if (shownAsks.has(a.id) || askQueue.some((x) => x.id === a.id)) continue;
    askQueue.push(a);
  }
  for (const r of s.replies) {
    if (shownReplies.has(r.id)) continue;
    shownReplies.add(r.id);
    playAlert();
    ENV.toast(`${r.from?.name || '對方'} 回覆了，點開看位置`);
    closeNotifications(`reply-${r.id}`);
    showResult(r.id, r);
  }
  nextAsk();
}

function nextAsk() {
  if ($('#find-dialog').open || !askQueue.length) return;
  const a = askQueue.shift();
  if (!state?.asks.some((x) => x.id === a.id)) return nextAsk(); // 已經回覆或逾時
  shownAsks.add(a.id);
  openAsk(a);
}

async function closeNotifications(tag) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    (await reg?.getNotifications({ tag }))?.forEach((n) => n.close());
  } catch { /* 略過 */ }
}

// 從通知點進來（SW 傳訊息或網址參數）
export async function openFromNotification(kind, findId) {
  if (!me || !ID_RE.test(findId || '')) return;
  await refresh();
  if (kind === 'ask') {
    const a = state?.asks.find((x) => x.id === findId);
    if (currentAsk?.id === findId) return;
    if (a) { shownAsks.add(a.id); openAsk(a); } else ENV.toast('這個請求已經回覆過或逾時了');
  } else if (kind === 'reply') {
    if ($('#find-result-dialog').open && $('#find-result-dialog').dataset.findId === findId) return;
    const r = state?.replies.find((x) => x.id === findId);
    shownReplies.add(findId);
    showResult(findId, r);
  }
}

// ---------- 回覆視窗（被問的人） ----------
let currentAsk = null;
let photoBlob = null;

function floorOptions(select, value = '1F') {
  clear(select);
  [...FLOORS, '戶外'].forEach((f) => select.append(h('option', { value: f, ...(f === value ? { selected: true } : {}) }, f === '戶外' ? '戶外／無樓層' : f)));
}

function resetPhoto() {
  photoBlob = null;
  const prev = $('#fd-preview');
  if (prev.src.startsWith('blob:')) URL.revokeObjectURL(prev.src);
  prev.removeAttribute('src');
  prev.hidden = true;
  $('#fd-photo-btn').textContent = '📷 拍一張照片（選填）';
  $('#fd-photo-input').value = '';
}

function openAsk(a) {
  currentAsk = a;
  playAlert();
  closeNotifications(`ask-${a.id}`);
  $('#fd-title').textContent = `${a.from?.emoji || ''} ${a.from?.name || '有人'} 問你在哪裡？`;
  floorOptions($('#fd-floor'), '1F');
  $('#fd-note').value = '';
  $('#fd-error').textContent = '';
  $('#fd-sound-hint').hidden = !!audio && audio.state === 'running';
  resetPhoto();
  $('#fd-submit').disabled = false;
  $('#fd-submit').textContent = '📍 送出我的位置';
  if (!$('#find-dialog').open) $('#find-dialog').showModal();
}

// 壓縮：最長邊 1280px、JPEG；盡量壓到 1.8MB 以內（後台上限 2MB）
export async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const hh = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hh;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, hh);
  bmp.close?.();
  const toBlob = (q) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('照片壓縮失敗'))), 'image/jpeg', q));
  let q = 0.82;
  let blob = await toBlob(q);
  while (blob.size > 1.8 * 1024 * 1024 && q > 0.4) { q -= 0.1; blob = await toBlob(q); }
  return blob;
}

async function onPhotoPicked(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    photoBlob = await compressImage(file);
    const prev = $('#fd-preview');
    if (prev.src.startsWith('blob:')) URL.revokeObjectURL(prev.src);
    prev.src = URL.createObjectURL(photoBlob);
    prev.hidden = false;
    $('#fd-photo-btn').textContent = '📷 重拍';
  } catch {
    $('#fd-error').textContent = '這張照片讀不了，請換一張或直接送出位置';
  }
}

export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('這個瀏覽器不支援定位'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy || 0) }),
      (err) => reject(new Error(err.code === 1 ? '沒有定位權限，請到瀏覽器設定允許定位後再試' : '定位失敗，請到訊號好的地方再試一次')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 },
    );
  });
}

async function submitReply(e) {
  e.preventDefault();
  if (!currentAsk) return;
  const btn = $('#fd-submit');
  btn.disabled = true;
  $('#fd-error').textContent = '';
  try {
    btn.textContent = '定位中…';
    const pos = await getPosition();
    if (photoBlob) {
      btn.textContent = '上傳照片…';
      await call('PUT', `/api/finds/${currentAsk.id}/photo`, { raw: photoBlob, type: 'image/jpeg' });
    }
    btn.textContent = '送出中…';
    const floor = $('#fd-floor').value;
    await callJson('POST', `/api/finds/${currentAsk.id}/reply`, { body: { ...pos, floor, note: $('#fd-note').value } });
    $('#find-dialog').close();
    ENV.toast('已送出你的位置');
    currentAsk = null;
    refresh();
  } catch (err) {
    $('#fd-error').textContent = err.message;
    btn.disabled = false;
    btn.textContent = '📍 送出我的位置';
    if (err.code === 'already_replied') { $('#find-dialog').close(); refresh(); }
  }
}

// ---------- 看回覆（發問的人）：地圖＋照片 ----------
let resultPhotoUrl = null;
async function showResult(findId, r) {
  if (!r) {
    // 已經看過（例如點舊的通知）：後台沒有留，提示一下
    ENV.toast('這筆回覆已經看過了，成員清單裡有最新位置');
    return;
  }
  const lat = Number(r.lat);
  const lng = Number(r.lng);
  $('#fr-title').textContent = `${r.from?.emoji || ''} ${r.from?.name || '對方'} 回覆了`;
  $('#fr-info').textContent = [r.floor, r.note, fmtAgo(r.repliedAt)].filter(Boolean).join('・');
  $('#fr-map').src = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.003},${lat - 0.002},${lng + 0.003},${lat + 0.002}&layer=mapnik&marker=${lat},${lng}`;
  $('#fr-nav').href = navUrl(lat, lng);
  $('#fr-nav').dataset.id = findId;
  const img = $('#fr-photo');
  img.hidden = true;
  if (resultPhotoUrl) URL.revokeObjectURL(resultPhotoUrl);
  resultPhotoUrl = null;
  $('#fr-photo-wait').hidden = !r.hasPhoto;
  if (!$('#find-result-dialog').open) $('#find-result-dialog').showModal();
  $('#find-result-dialog').dataset.findId = findId;
  call('POST', `/api/finds/${findId}/seen`).catch(() => {});
  if (r.hasPhoto) {
    try {
      const res = await call('GET', `/api/finds/${findId}/photo`);
      resultPhotoUrl = URL.createObjectURL(await res.blob());
      img.src = resultPhotoUrl;
      img.hidden = false;
    } catch { /* 沒照片就算了 */ }
    $('#fr-photo-wait').hidden = true;
  }
}

const navUrl = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${Number(lat)},${Number(lng)}`;

// ---------- 主畫面 ----------
function renderOff() {
  const server = getServer();
  const line = $('#group-server-line');
  if (!line) return;
  line.textContent = server ? `群組伺服器：${new URL(server).host}` : '還沒設定群組伺服器網址（到 ⚙️ 設定填入，由管理員提供）';
}

function renderInvite() {
  const box = $('#group-invite');
  clear(box);
  if (!me?.isAdmin) return;
  const link = me.inviteCode ? inviteLink() : null;
  if (link) {
    let src = '';
    try {
      const qr = qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      src = qr.createDataURL(5, 3);
    } catch { /* 太長就不顯示 QR */ }
    box.append(
      h('p', { class: 'hint' }, '邀請連結（傳給同行的人，或讓他掃 QR）：'),
      src ? h('img', { class: 'qr', src, alt: '邀請 QR Code', width: 180, height: 180 }) : null,
      h('input', { type: 'text', readonly: true, value: link, 'aria-label': '邀請連結', onfocus: (e) => e.target.select() }),
      h('div', { class: 'group-actions' },
        h('button', { type: 'button', class: 'ghost-btn', onclick: shareInvite }, '📤 分享連結'),
        h('button', { type: 'button', class: 'ghost-btn', onclick: resetInvite }, '🔄 重發邀請碼')),
    );
  } else {
    box.append(h('p', { class: 'hint' }, '這支手機沒有邀請碼，要邀請新朋友請重發一組（舊的會失效）'),
      h('button', { type: 'button', class: 'ghost-btn', onclick: resetInvite }, '🔄 重發邀請碼'));
  }
  box.append(h('button', { type: 'button', class: 'danger-btn', onclick: dissolve }, '解散群組（刪除所有人的位置與照片）'));
}

function inviteLink() {
  const base = `${location.origin}${location.pathname}`;
  // 放在 # 後面：瀏覽器不會把它送給網站主機（GitHub），邀請碼不會留在任何伺服器紀錄裡
  return `${base}#join=${encodeURIComponent(me.inviteCode)}&server=${encodeURIComponent(me.server)}`;
}

async function shareInvite() {
  const link = inviteLink();
  const text = `加入「${me.groupName}」，一起出遊找得到彼此：\n${link}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(link); ENV.toast('邀請連結已複製'); }
  } catch (err) {
    if (err?.name !== 'AbortError') ENV.toast('分享失敗，請長按上面的連結複製');
  }
}

async function resetInvite() {
  if (!confirm('重發邀請碼後，舊的連結和 QR 會立刻失效。要重發嗎？')) return;
  try {
    const r = await callJson('POST', '/api/invite/reset');
    me.inviteCode = r.inviteCode;
    saveMe();
    renderInvite();
    ENV.toast('新的邀請連結產生了');
  } catch (err) { ENV.toast(err.message); }
}

async function dissolve() {
  if (!confirm('解散後所有人的位置、照片都會被刪除，無法復原。確定要解散嗎？')) return;
  try {
    await call('DELETE', '/api/group');
    leaveLocal('群組已解散，資料都刪除了');
  } catch (err) { ENV.toast(err.message); }
}

async function leaveGroup() {
  if (!confirm('離開群組後，你的位置與照片會從後台刪除。確定要離開嗎？')) return;
  try {
    await call('DELETE', '/api/me');
    leaveLocal('已離開群組');
  } catch (err) { ENV.toast(err.message); }
}

function memberRow(m) {
  const here = ENV.getHere();
  const mine = state.members.find((x) => x.isMe);
  const origin = here || (mine?.lat != null ? { lat: mine.lat, lng: mine.lng } : null);
  const hasLoc = m.lat != null && m.lng != null;
  const bits = [];
  if (hasLoc) {
    if (!m.isMe && origin) bits.push(`離你 ${ENV.fmtDist(ENV.haversine(origin, { lat: m.lat, lng: m.lng }))}`);
    bits.push(fmtAgo(m.locAt));
    if (m.floor) bits.push(m.floor);
    if (m.note) bits.push(`「${m.note}」`);
  } else bits.push('還沒回報位置');

  const name = h('div', { class: 'm-name' },
    h('span', { class: 'm-emoji' }, m.emoji), h('b', null, m.name),
    m.isMe ? h('span', { class: 'badge' }, '我') : null,
    m.isAdmin ? h('span', { class: 'badge badge-admin' }, '管理員') : null,
    h('span', { class: `badge ${m.tier === 'family' ? 'badge-family' : 'badge-friend'}` }, m.tier === 'family' ? '家人' : '朋友'));

  const actions = h('div', { class: 'm-actions' });
  if (hasLoc) actions.append(h('a', { class: 'nav-btn', href: navUrl(m.lat, m.lng), target: '_blank', rel: 'noopener' }, '導航'));
  if (!m.isMe) actions.append(h('button', { type: 'button', class: 'find-btn', 'data-find': m.id, onclick: () => findOne(m) }, '📣 找他'));
  if (me.isAdmin && !m.isMe && !m.isAdmin) {
    actions.append(
      h('select', { 'aria-label': `${m.name} 的身分`, onchange: (e) => setTier(m, e.target.value) },
        h('option', { value: 'friend', ...(m.tier === 'friend' ? { selected: true } : {}) }, '朋友'),
        h('option', { value: 'family', ...(m.tier === 'family' ? { selected: true } : {}) }, '家人')),
      h('button', { type: 'button', class: 'kick-btn', onclick: () => kick(m) }, '踢出'),
    );
  }
  return h('li', { class: 'member' }, name, h('div', { class: 'm-meta' }, bits.join('・')), actions);
}

async function findOne(m) {
  try {
    const r = await callJson('POST', '/api/find', { body: { targetId: m.id } });
    const pushed = r.finds[0].pushed === 'sent';
    ENV.toast(pushed ? `已通知 ${m.name}，等他回覆` : `已發出，${m.name} 打開 App 時會看到（他還沒開啟通知）`);
  } catch (err) { ENV.toast(err.message); }
}

async function findAll() {
  try {
    const r = await callJson('POST', '/api/find', { body: { all: true } });
    const pushed = r.finds.filter((f) => f.pushed === 'sent').length;
    ENV.toast(`已問全部 ${r.finds.length} 個人（${pushed} 人收到推播通知）`);
  } catch (err) { ENV.toast(err.message); }
}

async function setTier(m, tier) {
  try {
    await callJson('PATCH', `/api/members/${m.id}`, { body: { tier } });
    ENV.toast(`${m.name} 現在是${tier === 'family' ? '家人（可用共用金鑰）' : '朋友（要自己輸入金鑰）'}`);
  } catch (err) { ENV.toast(err.message); }
  refresh();
}

async function kick(m) {
  if (!confirm(`要把「${m.name}」踢出群組嗎？他的位置和照片會被刪除。`)) return;
  try {
    await call('DELETE', `/api/members/${m.id}`);
    ENV.toast(`${m.name} 已被移出群組`);
  } catch (err) { ENV.toast(err.message); }
  refresh();
}

function renderPushLine() {
  const el = $('#group-push');
  clear(el);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!state?.pushEnabled) { el.append('通知：後台沒有開啟推播，只有 App 開著時才會提示'); return; }
  if (!supported) { el.append('通知：這個瀏覽器不支援推播（iPhone 請先「加入主畫面」再開啟）'); return; }
  if (Notification.permission === 'denied') { el.append('通知：已被封鎖，請到瀏覽器／系統設定允許通知'); return; }
  if (state.me.hasPush && Notification.permission === 'granted') { el.append('🔔 通知已開啟，有人找你時手機會響'); return; }
  el.append('🔕 通知還沒開啟：有人找你時，App 沒開著就收不到。 ',
    h('button', { type: 'button', class: 'link-btn', id: 'group-enable-push', onclick: enablePush }, '開啟通知'));
}

const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return ENV.toast('沒有允許通知，別人找你時只會在 App 開著時提示');
    const { publicKey } = await callJson('GET', '/api/push/key', { auth: false });
    if (!publicKey) return ENV.toast('後台沒有設定推播金鑰');
    const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('sw.js'));
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }));
    await callJson('PUT', '/api/push', { body: { subscription: sub.toJSON() } });
    ENV.toast('通知已開啟');
    refresh();
  } catch (err) {
    ENV.toast(`開啟通知失敗：${err.message}`);
  }
}

function render() {
  const on = !!me;
  $('#group-off').hidden = on;
  $('#group-on').hidden = !on;
  renderOff();
  if (!on || !state) {
    if (on) { $('#group-name').textContent = me.groupName; $('#group-meta').textContent = '載入中…'; }
    return;
  }
  const key = JSON.stringify([state.members, state.group, state.me, state.pushEnabled, Math.floor(Date.now() / 60000), ENV.getHere()?.lat]);
  if (key === lastKey) return;
  lastKey = key;
  $('#group-name').textContent = `${state.group.name}`;
  $('#group-meta').textContent = `${state.members.length} 人・${fmtExpiry(state.group.expiresAt)}`;
  const mineTier = state.me.tier === 'family' ? '你是「家人」：附近／順路／AI 可用共用金鑰' : '你是「朋友」：附近／順路／AI 請自己輸入金鑰（⚙️ 設定）';
  $('#group-tier').textContent = mineTier;
  const list = $('#group-members');
  clear(list);
  state.members.forEach((m) => list.append(memberRow(m)));
  $('#group-find-all').hidden = state.members.length < 2;
  renderInvite();
  renderPushLine();
}

// ---------- 我在這 ----------
function openHere() {
  floorOptions($('#hr-floor'), state?.me.floor || '1F');
  $('#hr-note').value = '';
  $('#hr-error').textContent = '';
  $('#here-dialog').showModal();
}

async function submitHere(e) {
  e.preventDefault();
  const btn = $('#hr-submit');
  btn.disabled = true;
  $('#hr-error').textContent = '';
  try {
    btn.textContent = '定位中…';
    const pos = await getPosition();
    await callJson('POST', '/api/location', { body: { ...pos, floor: $('#hr-floor').value, note: $('#hr-note').value } });
    $('#here-dialog').close();
    ENV.toast('位置已更新（不會通知別人）');
    lastKey = '';
    refresh();
  } catch (err) {
    $('#hr-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '送出';
  }
}

// ---------- 初始化 ----------
export function onShow() {
  render();
  refresh();
}

export function initGroup(env) {
  Object.assign(ENV, env);
  me = loadMe();
  applyGateway();

  $('#group-create').addEventListener('click', openCreate);
  $('#group-paste').addEventListener('click', promptPasteInvite);
  $('#group-open-settings').addEventListener('click', () => ENV.openSettings());
  $('#group-find-all').addEventListener('click', findAll);
  $('#group-here').addEventListener('click', openHere);
  $('#group-leave').addEventListener('click', () => (me?.isAdmin ? dissolve() : leaveGroup()));
  $('#gc-form').addEventListener('submit', submitCreate);
  $('#gj-form').addEventListener('submit', submitJoin);
  $('#hr-form').addEventListener('submit', submitHere);
  $('#fd-form').addEventListener('submit', submitReply);
  $('#fd-photo-btn').addEventListener('click', () => $('#fd-photo-input').click());
  $('#fd-photo-input').addEventListener('change', onPhotoPicked);
  $('#fd-later').addEventListener('click', () => $('#find-dialog').close());
  $('#find-dialog').addEventListener('close', () => { currentAsk = null; resetPhoto(); setTimeout(nextAsk, 300); });
  $('#fr-close').addEventListener('click', () => $('#find-result-dialog').close());
  $('#find-result-dialog').addEventListener('close', () => {
    $('#fr-map').removeAttribute('src');
    if (resultPhotoUrl) { URL.revokeObjectURL(resultPhotoUrl); resultPhotoUrl = null; }
  });
  $('#gp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inv = parseInvite($('#gp-text').value);
    if (!inv) { $('#gp-error').textContent = '看不到邀請連結，請把整段連結貼上'; return; }
    $('#group-paste-dialog').close();
    openJoin(inv);
  });
  document.querySelectorAll('.gd-cancel').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open-find') openFromNotification(e.data.kind, e.data.findId);
  });

  render();
  if (me) {
    startPolling();
    refresh();
  }

  // 邀請連結／通知網址參數
  const q = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const join = hash.get('join');
  const find = q.get('find');
  const server = hash.get('server');
  if (join || find) {
    // 把邀請碼從網址列拿掉（也避免重新整理後又跳出加入視窗）
    history.replaceState(null, '', location.pathname + (q.has('mock') ? '?mock' : ''));
  }
  return { join, server, find, kind: q.get('kind') };
}

export { openJoin };
