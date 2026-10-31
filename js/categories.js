// 每個類別：types 走 Nearby Search（依 Google 分類），queries 走 Text Search（依關鍵字），兩者結果合併去重
// alongQueries：順路搜尋只能用關鍵字，沒有 queries 的類別改用這組（都沒有就用類別名稱）
// openNow: true 自動排除沒營業的店（依「什麼時候去」的時間判斷）
// mealTime：時間設「現在」且還沒到 start 時，自動改看今天 pick 這個時間
// food: true 會顯示料理類型與「餐廳／小吃店」標籤
export const CATEGORIES = [
  {
    id: 'breakfast', name: '早餐', icon: '🍳', food: true, openNow: true, mealTime: { start: '06:00', pick: '08:00' },
    queries: ['早餐店', '早午餐'],
  },
  {
    id: 'lunch', name: '午餐', icon: '🍱', food: true, openNow: true, mealTime: { start: '11:00', pick: '12:00' },
    types: ['restaurant', 'meal_takeaway'], alongQueries: ['餐廳', '小吃'],
  },
  {
    id: 'dinner', name: '晚餐', icon: '🍲', food: true, openNow: true, mealTime: { start: '17:00', pick: '18:30' },
    types: ['restaurant', 'meal_takeaway'], alongQueries: ['餐廳', '小吃'],
  },
  {
    id: 'cafe', name: '咖啡甜點', icon: '☕', openNow: true,
    types: ['cafe', 'coffee_shop', 'dessert_shop', 'bakery', 'tea_house'],
    fallbackTypes: ['cafe', 'bakery'], alongQueries: ['咖啡廳', '甜點'],
  },
  { id: 'kids-in', name: '室內遛小孩', icon: '🧸', queries: ['親子館', '室內遊樂場', '親子餐廳'] },
  { id: 'kids-out', name: '室外遛小孩', icon: '🛝', types: ['playground', 'park'], alongQueries: ['公園', '兒童遊戲場'] },
  { id: 'parking', name: '停車場', icon: '🅿️', types: ['parking'], alongQueries: ['停車場'] },
  { id: 'toilet', name: '廁所', icon: '🚻', types: ['public_bathroom'], queries: ['公廁'] },
  { id: 'chill', name: '發呆好地方', icon: '🌅', queries: ['景觀咖啡', '觀景台', '河濱公園'] },
];
