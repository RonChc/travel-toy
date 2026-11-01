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

// 非吃的類別：店名關鍵字 → Google 類型 → Google 顯示名稱，給「類型按鈕列」分組用
const PLACE_NAME_RULES = [
  [/手搖|茶飲|飲料|奶茶|珍奶|50嵐|清心|可不可|迷客夏|coco|大苑子|麻古|金點子|再睡5分鐘|茶湯會|五桐號|得正|鮮茶道|龜記/i, '手搖飲'],
  [/甜點|蛋糕|甜品|豆花|剉冰|冰店|雪花冰|鬆餅|布丁|可麗露|cake|dessert/i, '甜點'],
  [/麵包|烘焙|bakery/i, '麵包店'],
  [/咖啡|coffee|caf[eé]|珈琲|星巴克|路易莎|cama/i, '咖啡廳'],
  [/親子館|育兒|兒童館/, '親子館'],
  [/親子餐廳/, '親子餐廳'],
  [/遊樂|樂園|球池|淘氣堡|兒童室內/, '室內遊樂場'],
  [/博物館|美術館|科學館|展覽|文化館|紀念館/, '展館'],
  [/圖書館|書店|繪本/, '圖書/書店'],
  [/百貨|購物中心|商場|outlet/i, '百貨商場'],
  [/農場|牧場|休閒園區/, '農場'],
  [/遊戲場|特色公園|共融/, '兒童遊戲場'],
  [/河濱|濕地|海邊|海灘|沙灘|海岸|漁港/, '河濱/海邊'],
  [/步道|登山|森林/, '步道'],
  [/觀景|景觀|夜景|眺望/, '景觀'],
  [/路邊|路外/, '路邊停車'],
  [/立體停車|停車大樓/, '立體停車場'],
  [/加油站/, '加油站'],
  [/7-11|7-eleven|統一超商|全家|萊爾富|ok超商|ok mart/i, '便利商店'],
];

const TYPE_LABELS = {
  cafe: '咖啡廳', coffee_shop: '咖啡廳', dessert_shop: '甜點', bakery: '麵包店', tea_house: '茶館',
  ice_cream_shop: '甜點', confectionery: '甜點', juice_shop: '手搖飲',
  playground: '兒童遊戲場', park: '公園', city_park: '公園', national_park: '公園',
  indoor_playground: '室內遊樂場', amusement_center: '室內遊樂場', amusement_park: '遊樂園',
  museum: '展館', art_gallery: '展館', library: '圖書/書店', book_store: '圖書/書店',
  shopping_mall: '百貨商場', department_store: '百貨商場', zoo: '動物園', aquarium: '水族館',
  farm: '農場', hiking_area: '步道', observation_deck: '景觀', scenic_spot: '景觀', beach: '河濱/海邊',
  parking: '停車場', parking_lot: '停車場', parking_garage: '立體停車場',
  public_bathroom: '公廁', gas_station: '加油站', convenience_store: '便利商店',
};

export function placeLabel(place) {
  const name = place.displayName?.text || '';
  for (const [re, label] of PLACE_NAME_RULES) if (re.test(name)) return label;
  if (TYPE_LABELS[place.primaryType]) return TYPE_LABELS[place.primaryType];
  if (place.primaryType && !GENERIC_TYPES.has(place.primaryType) && place.primaryTypeDisplayName?.text) {
    return place.primaryTypeDisplayName.text;
  }
  return '其他';
}

// 蔬食：2 = 素食店、1 = 有素食可吃、0 = 看不出來
const VEG_NAME = /素食|蔬食|素齋|齋菜|全素|蛋奶素|vegan|vegetarian/i;
const VEG_REVIEW = /(有|提供|可以?|能)[^，。！？\s]{0,3}(素食|蔬食|素的|素料理)|素食者|吃素的(朋友|人)/;
export function vegLevel(place) {
  const name = place.displayName?.text || '';
  if (VEG_NAME.test(name) || /vegan|vegetarian/.test(place.primaryType || '')) return 2;
  if (place.servesVegetarianFood) return 1;
  if ((place.reviews || []).some((r) => VEG_REVIEW.test(r.text?.text || r.originalText?.text || ''))) return 1;
  return 0;
}
