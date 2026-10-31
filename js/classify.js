// 料理類型與店型判斷：先用 Google 的 primaryType，太籠統時改用店名關鍵字推估

const GENERIC_TYPES = new Set([
  'restaurant', 'food', 'point_of_interest', 'establishment',
  'meal_takeaway', 'meal_delivery', 'store', 'food_store',
]);

const NAME_RULES = [
  [/拉麵|ラーメン/, '拉麵'],
  [/壽司|丼|日式|居酒屋|定食|燒肉|日本料理/, '日式'],
  [/義大利|義式|披薩|pizza|pasta/i, '義式'],
  [/韓式|韓國|韓食/, '韓式'],
  [/泰式|泰國/, '泰式'],
  [/越南|越式|河粉/, '越式'],
  [/港式|茶餐廳|燒臘/, '港式'],
  [/漢堡|美式|牛排/, '美式'],
  [/火鍋|鍋物|麻辣鍋|涮涮|小火鍋/, '火鍋'],
  [/早午餐|brunch/i, '早午餐'],
  [/早餐|蛋餅|美而美|晨間/, '早餐'],
  [/牛肉麵|麵館|麵店|乾麵|意麵|麵線/, '麵食'],
  [/便當|飯包|自助餐/, '便當/自助餐'],
  [/水餃|餃子|鍋貼/, '餃子'],
  [/素食|蔬食/, '素食'],
  [/咖哩|印度/, '咖哩/印度'],
  [/熱炒|快炒|海產/, '熱炒'],
  [/燒烤|串燒|烤肉/, '燒烤'],
  [/滷肉飯|魯肉飯|小吃|肉圓|蚵仔|米糕|碗粿/, '台式小吃'],
  [/川菜|江浙|客家|台菜|中式|中餐/, '中式'],
];

export function cuisineLabel(place) {
  const display = place.primaryTypeDisplayName?.text;
  if (place.primaryType && !GENERIC_TYPES.has(place.primaryType) && display) {
    return display.length > 3 ? display.replace(/餐廳$/, '') : display;
  }
  const name = place.displayName?.text || '';
  for (const [re, label] of NAME_RULES) if (re.test(name)) return label;
  return display || '餐廳';
}

const CHEAP_NAME = /小吃|攤|麵|便當|滷味|早餐|飯糰|雞排|豆花|肉圓|水餃|鍋貼|自助餐|粥/;
const PRICEY = ['PRICE_LEVEL_MODERATE', 'PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE'];

// 回傳「餐廳」或「小吃店」（推估，非 Google 官方分類）
export function shopKind(place) {
  const types = place.types || [];
  const name = place.displayName?.text || '';
  if (types.includes('fine_dining_restaurant') || PRICEY.includes(place.priceLevel)) return '餐廳';
  if (
    place.priceLevel === 'PRICE_LEVEL_INEXPENSIVE' ||
    CHEAP_NAME.test(name) ||
    types.includes('fast_food_restaurant') ||
    types.includes('food_court') ||
    (types.includes('meal_takeaway') && !types.includes('restaurant'))
  ) return '小吃店';
  return '餐廳';
}
