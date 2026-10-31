// 測試模式（網址加 ?mock）：不呼叫 Google，產生假資料，方便沒有金鑰時測介面
import { isOpenAt } from './hours.js';

const SAMPLES = [
  ['阿明牛肉麵', 'restaurant', '餐廳', 'PRICE_LEVEL_INEXPENSIVE'],
  ['Trattoria 義式小館', 'italian_restaurant', '義式餐廳', 'PRICE_LEVEL_MODERATE'],
  ['一蘭風拉麵', 'ramen_restaurant', '拉麵店', 'PRICE_LEVEL_MODERATE'],
  ['美而美早餐', 'breakfast_restaurant', '早餐店', 'PRICE_LEVEL_INEXPENSIVE'],
  ['老王滷肉飯', 'restaurant', '餐廳', null],
  ['首爾韓式炸雞', 'korean_restaurant', '韓式餐廳', null],
  ['湄南河泰式料理', 'thai_restaurant', '泰式餐廳', 'PRICE_LEVEL_MODERATE'],
  ['港記茶餐廳', 'restaurant', '餐廳', null],
  ['好味便當', 'meal_takeaway', '外賣餐廳', 'PRICE_LEVEL_INEXPENSIVE'],
  ['川味小館', 'chinese_restaurant', '中式餐廳', 'PRICE_LEVEL_MODERATE'],
  ['日光咖啡', 'cafe', '咖啡廳', null],
  ['河濱公園', 'park', '公園', null],
  ['小樹親子館', 'indoor_playground', '室內遊樂場', null],
  ['市府停車場', 'parking', '停車場', null],
  ['公園公廁', 'public_bathroom', '公共廁所', null],
];

// 營業時間樣式：午晚餐（11-14、17-21）、早餐（06-13）、全天（11-21）；每 7 間有 1 間沒資料
const HOURS = [[[11, 14], [17, 21]], [[6, 13]], [[11, 21]]];
function mockHours(i) {
  if (i % 7 === 3) return {};
  const periods = [];
  for (let day = 0; day < 7; day++) {
    for (const [o, c] of HOURS[i % 3]) {
      periods.push({ open: { day, hour: o, minute: 0 }, close: { day, hour: c, minute: 0 } });
    }
  }
  const place = { regularOpeningHours: { periods } };
  return { ...place, currentOpeningHours: { openNow: isOpenAt(place, new Date()) } };
}

function rand(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function searchNearby(key, center, radius, types) {
  await sleep(300);
  return SAMPLES.map(([name, type, display, price], i) => ({
    id: `mock-${i}`,
    displayName: { text: name },
    location: {
      latitude: center.lat + (rand(i + 1) - 0.5) * 0.04,
      longitude: center.lng + (rand(i + 50) - 0.5) * 0.04,
    },
    rating: Math.round((3.2 + rand(i + 9) * 1.8) * 10) / 10,
    userRatingCount: Math.floor(rand(i + 3) * 3000),
    primaryType: type,
    primaryTypeDisplayName: { text: display },
    types: [type, 'food', 'point_of_interest'],
    priceLevel: price || undefined,
    ...mockHours(i),
    googleMapsUri: 'https://maps.google.com/',
    shortFormattedAddress: `測試路 ${i + 1} 號`,
  }));
}

export async function searchText(key, query, center, radius) {
  return searchNearby(key, center, radius, []);
}

export async function geocode(key, text) {
  await sleep(200);
  const h = [...text].reduce((s, c) => s + c.charCodeAt(0), 0);
  return { lat: 25.0339 + (rand(h) - 0.5) * 0.2, lng: 121.5645 + (rand(h + 1) - 0.5) * 0.2, label: text };
}

const SPEED = { DRIVE: 7, WALK: 1.3 }; // m/s

export async function computeRoute(key, a, b, mode) {
  await sleep(200);
  const meters = Math.round(dist(a, b) * 1.3);
  return { seconds: Math.round(meters / SPEED[mode]), meters, polyline: JSON.stringify([a, b]) };
}

// 假資料沿 A→B 直線散佈
export async function searchAlongRoute(key, query, polyline, origin, mode) {
  const [a, b] = JSON.parse(polyline);
  const places = await searchNearby(key, a, 0, []);
  return places.map((p, i) => {
    const t = rand(i + 21);
    const loc = {
      lat: a.lat + (b.lat - a.lat) * t + (rand(i + 31) - 0.5) * 0.02,
      lng: a.lng + (b.lng - a.lng) * t + (rand(i + 41) - 0.5) * 0.02,
    };
    const leg = (x, y) => {
      const meters = Math.round(dist(x, y) * 1.3);
      return { seconds: Math.round(meters / SPEED[mode]), meters };
    };
    return { ...p, location: { latitude: loc.lat, longitude: loc.lng }, legs: [leg(a, loc), leg(loc, b)] };
  });
}

export async function routeMatrix(key, origin, dests, mode) {
  await sleep(300);
  const speed = SPEED[mode];
  return dests.map((d, i) => {
    const meters = Math.round(dist(origin, d) * (1.25 + rand(i) * 0.3));
    return { seconds: Math.round(meters / speed + (mode === 'DRIVE' ? 120 : 0)), meters };
  });
}

function dist(a, b) {
  const dx = (a.lng - b.lng) * 101000;
  const dy = (a.lat - b.lat) * 111000;
  return Math.hypot(dx, dy);
}
