// Google Places API (New) 與 Routes API，直接從瀏覽器呼叫（金鑰需設定 HTTP referrer 限制）

const PLACES = 'https://places.googleapis.com/v1/places';
const ROUTES = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

const PLACE_FIELDS = [
  'id', 'displayName', 'location', 'rating', 'userRatingCount', 'primaryType',
  'primaryTypeDisplayName', 'types', 'priceLevel', 'currentOpeningHours.openNow',
  'googleMapsUri', 'shortFormattedAddress',
].map((f) => `places.${f}`).join(',');

async function post(url, body, fieldMask, key) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (Array.isArray(data) ? data[0] : data)?.error?.message;
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return data;
}

const latLng = ({ lat, lng }) => ({ latitude: lat, longitude: lng });

export async function searchNearby(key, center, radius, types) {
  const data = await post(`${PLACES}:searchNearby`, {
    includedTypes: types,
    maxResultCount: 20,
    rankPreference: 'DISTANCE',
    languageCode: 'zh-TW',
    regionCode: 'TW',
    locationRestriction: { circle: { center: latLng(center), radius } },
  }, PLACE_FIELDS, key);
  return data.places || [];
}

export async function searchText(key, query, center, radius) {
  const data = await post(`${PLACES}:searchText`, {
    textQuery: query,
    pageSize: 20,
    rankPreference: 'DISTANCE',
    languageCode: 'zh-TW',
    regionCode: 'TW',
    locationBias: { circle: { center: latLng(center), radius } },
  }, PLACE_FIELDS, key);
  return data.places || [];
}

// 地址或地標 → 座標
export async function geocode(key, text) {
  const data = await post(`${PLACES}:searchText`, {
    textQuery: text,
    pageSize: 1,
    languageCode: 'zh-TW',
    regionCode: 'TW',
  }, 'places.location,places.displayName,places.shortFormattedAddress', key);
  const p = data.places?.[0];
  if (!p) throw new Error('找不到這個地點');
  return {
    lat: p.location.latitude,
    lng: p.location.longitude,
    label: p.displayName?.text || p.shortFormattedAddress || text,
  };
}

// 回傳與 dests 同順序的 [{ seconds, meters } | null]
export async function routeMatrix(key, origin, dests, mode) {
  const body = {
    origins: [{ waypoint: { location: { latLng: latLng(origin) } } }],
    destinations: dests.map((d) => ({ waypoint: { location: { latLng: latLng(d) } } })),
    travelMode: mode,
    languageCode: 'zh-TW',
  };
  if (mode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE';
  const rows = await post(ROUTES, body,
    'originIndex,destinationIndex,duration,distanceMeters,condition', key);
  const out = dests.map(() => null);
  for (const r of rows || []) {
    if (r.condition !== 'ROUTE_EXISTS') continue;
    out[r.destinationIndex] = { seconds: parseInt(r.duration, 10), meters: r.distanceMeters };
  }
  return out;
}
