// 測試模式（網址加 ?mock）：不呼叫 Google，產生假資料，方便沒有金鑰時測介面

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
    currentOpeningHours: { openNow: rand(i + 7) > 0.25 },
    googleMapsUri: 'https://maps.google.com/',
    shortFormattedAddress: `測試路 ${i + 1} 號`,
  }));
}

export async function searchText(key, query, center, radius) {
  return searchNearby(key, center, radius, []);
}

export async function geocode(key, text) {
  await sleep(200);
  return { lat: 25.0339, lng: 121.5645, label: text };
}

export async function routeMatrix(key, origin, dests, mode) {
  await sleep(300);
  const speed = mode === 'DRIVE' ? 7 : 1.3; // m/s
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
