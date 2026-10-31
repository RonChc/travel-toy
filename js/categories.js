// 每個類別：types 走 Nearby Search（依 Google 分類），queries 走 Text Search（依關鍵字），兩者結果合併去重
// food: true 會顯示料理類型與「餐廳／小吃店」標籤
export const CATEGORIES = [
  { id: 'breakfast', name: '早餐', icon: '🍳', food: true, queries: ['早餐店', '早午餐'] },
  { id: 'lunch', name: '午餐', icon: '🍱', food: true, types: ['restaurant', 'meal_takeaway'] },
  { id: 'dinner', name: '晚餐', icon: '🍲', food: true, types: ['restaurant', 'meal_takeaway'] },
  {
    id: 'cafe', name: '咖啡甜點', icon: '☕',
    types: ['cafe', 'coffee_shop', 'dessert_shop', 'bakery', 'tea_house'],
    fallbackTypes: ['cafe', 'bakery'],
  },
  { id: 'kids-in', name: '室內遛小孩', icon: '🧸', queries: ['親子館', '室內遊樂場', '親子餐廳'] },
  { id: 'kids-out', name: '室外遛小孩', icon: '🛝', types: ['playground', 'park'] },
  { id: 'parking', name: '停車場', icon: '🅿️', types: ['parking'] },
  { id: 'toilet', name: '廁所', icon: '🚻', types: ['public_bathroom'], queries: ['公廁'] },
  { id: 'chill', name: '發呆好地方', icon: '🌅', queries: ['景觀咖啡', '觀景台', '河濱公園'] },
];
