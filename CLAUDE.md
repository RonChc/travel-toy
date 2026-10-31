# 旅遊玩意
類型：程式開發　建立：2026-10-31

## 專案目標
開發一個手機pwa網頁 可以達成在擷取當下定位或輸入地址或位置後 搜尋一下不同分類   例如 早餐 午餐 晚餐  咖啡廳甜點）  室內遛小孩  室外溜小孩 停車場 廁所  發呆好地方  以上搜尋google map 取得評分及評分數量  距離多遠 路程時間 點選類別後幫我搜尋復健10間 要讓我選幾分以上 或從近排到遠  最快抵達 之類的  並且例如午餐可以幫我顯示每間是中式 義式 或主要是什麼類型的食物  是餐廳還是小吃店嗎

## 已確認規格
- 交通方式：開車／走路都要，畫面上切換（各算一次，有快取）
- 使用者：自己＋家人，量不大 → 走 Google 免費額度
- 使用者有 Google Cloud 帳號，可綁卡
- 類別關鍵字照 `js/categories.js` 的設定（已同意）
- 每次點類別：取候選（最多 25 間，依直線距離）→ 算路程 → 篩選排序 → 顯示 10 間，可「再顯示 10 間」
- 篩選：範圍、最低評分、最少評論數、只看營業中；排序：近到遠、最快抵達、評分、評論數
- 「餐廳／小吃店」是推估（價位＋分類＋店名關鍵字），非 Google 官方

## 技術架構
- 純前端靜態網頁（HTML + 原生 JS ES modules，無 build），PWA（manifest + sw.js）
- 資料：Google Places API (New)（searchNearby / searchText）、Routes API（computeRouteMatrix），瀏覽器直接 fetch（已確認 CORS 可用）
- API 金鑰：使用者在 App 設定裡輸入，存手機 localStorage，不放進程式碼
- 部署：預計 GitHub Pages（定位需要 HTTPS）

## 如何執行
```
node tools/serve.mjs          # http://localhost:5173
http://localhost:5173/?mock   # 測試模式：假資料，不需金鑰
```

## 資料夾結構
- `index.html`、`css/style.css`、`manifest.webmanifest`、`sw.js`、`icons/`
- `js/app.js` 畫面與流程、`js/api.js` Google API、`js/categories.js` 類別設定
- `js/classify.js` 料理類型／店型判斷、`js/mock.js` 測試假資料
- `tools/serve.mjs` 本機伺服器

## 開發慣例
- 改完程式要實際跑過、確認能用，再回報完成。
- 重要變更用 git commit 留紀錄。

## 目前進度
- 2026-10-31 完成第一版：全部類別、定位／地址、開車走路切換、篩選排序、料理類型標籤、PWA；測試模式下跑過無錯誤
- 2026-10-31 建立專案

## 下一步
- 使用者申請 Google API 金鑰（開 Places API (New) + Routes API，限制 HTTP referrer）
- 部署到 GitHub Pages，手機實測真實資料
- 依實測調整：類別關鍵字、料理類型判斷準確度
- 之後可加：政府公廁開放資料、收藏清單
