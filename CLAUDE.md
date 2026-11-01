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
- 吃的類別（早午晚餐）結果上方有類型按鈕列：全部／小吃店／餐廳＋各料理類型（附數量），可複選店型＋料理
- 非吃的類別也有類型按鈕列（全部＋咖啡廳／手搖飲／甜點／親子館／公園…，`classify.js` 的 placeLabel：店名關鍵字→Google 類型），只有一種類型時不顯示
- 卡片顯示「👍 招牌／特色」：搜尋時多拿 Google 評論（reviews、editorialSummary），有 Claude 金鑰就用 `claude-haiku-5-5` 一次整理顯示中的店，結果存手機 30 天（`travel-toy-highlights`）；沒金鑰只顯示 Google 簡介
- 蔬食：同行成員勾「有人吃素」或吃的類別按「🥬 蔬食優先」（同一個設定 party.veg）→ 多搜「素食」、素食店→有蔬食→其他排序；綠色標籤「素食店」（店名/類型）「有蔬食」（Google servesVegetarianFood 或評論提到）
- 兩個分頁：📍附近（以定位／地址為中心）、🛣️順路（A→B，A 空白=目前位置）
- 順路：Places Text Search 的 searchAlongRoute + routingSummaries 算「繞路多幾分鐘」；繞路上限 5/10/15/20/30 分；排序 繞路最少／評分／評論數／沿路先到；導航連結帶 A→店→B
- 順路只能用關鍵字，類別用 `alongQueries`（categories.js）；切換開車／走路要重搜
- 兩分頁都有關鍵字搜尋框（例：牛肉湯）；關鍵字結果大多是吃的就自動出現類型按鈕
- 早餐／午餐／晚餐／咖啡甜點（`openNow: true`）自動排除沒營業的；營業時間不明的保留並標「時間不明」
- 時間設定：現在出發／幾點出發／幾點抵達（今天～後天＋時間）。一律判斷「抵達那間店的時間」有沒有營業（出發＝出發時間＋路程），用 regularOpeningHours.periods 推算（`js/hours.js`）；「現在出發」另參考 Google openNow 抓臨時公休；卡片顯示「約幾點到」或「幾點出發」
- 時間是「現在」但還沒到用餐時段（mealTime.start）時，點早午晚餐會自動改成「幾點抵達＝今天 pick」（早 08:00／午 12:00／晚 18:30）
- 同行成員（👨‍👩‍👧 按鈕）：大人、長輩人數＋小孩（3–12 歲）、幼兒（0–2 歲）各自年齡＋其他需求；存手機
- AI（`js/ai.js`，Claude `claude-opus-5-5`，SDK 從 jsdelivr CDN 載入 @anthropic-ai/sdk@1.3.0，瀏覽器直連，`fallbacks: "default"`）：
  - 「AI 幫我挑」：把目前結果前 20 間＋同行成員送給 Claude，結構化輸出挑 3–5 間＋理由（effort low）
  - 「AI 行程」分頁：Claude 用 search_places 工具（我們的 Google Text Search）自己找真實地點排時間軸，串流顯示，地點名稱自動變地圖連結（effort medium）
  - Claude 金鑰在設定裡，存手機；無法限制網址 → 建議使用者在 Claude Console 設每月上限
- 設定碼：設定裡「分享設定給家人」產生 TT1:+base64url(JSON{key,claudeKey,party})，家人貼到「設定碼」欄即套用（iPhone 主畫面 App 與 Safari 資料分開，要在主畫面 App 裡貼）
- 版面：只用淺色（使用者不要黑底），篩選改成一排小膠囊選單
- 「餐廳／小吃店」是推估（價位＋分類＋店名關鍵字），非 Google 官方

## 技術架構
- 純前端靜態網頁（HTML + 原生 JS ES modules，無 build），PWA（manifest + sw.js）
- 資料：Google Places API (New)（searchNearby / searchText）、Routes API（computeRouteMatrix），瀏覽器直接 fetch（已確認 CORS 可用）
- API 金鑰：使用者在 App 設定裡輸入，存手機 localStorage，不放進程式碼
- 部署：GitHub Pages https://ronchc.github.io/travel-toy/ （repo RonChc/travel-toy 公開，master 根目錄；git push 後約 1 分鐘自動更新）

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
- 2026-11-01 加入蔬食優先與蔬食標籤（測試模式跑過）
- 2026-11-01 卡片加上招牌／特色（AI 讀 Google 評論整理，測試模式跑過）
- 2026-11-01 所有類別都有類型分類按鈕（測試模式跑過）
- 2026-10-31 加入設定碼分享，家人免輸入金鑰（測試跑過）
- 2026-10-31 加入同行成員、AI 幫我挑、AI 行程；版面改淺色精簡；修「再顯示 10 間」誤顯示（測試模式＋真 SDK 連線驗證）
- 2026-10-31 已部署到 GitHub Pages，線上測試模式正常
- 2026-10-31 時間設定改為 現在出發／幾點出發／幾點抵達（測試模式跑過）
- 2026-10-31 加入「什麼時候去」時間設定、用餐時段自動帶時間、順路看抵達時營業（測試模式跑過）
- 2026-10-31 餐點類別自動排除沒營業的店（測試模式跑過）
- 2026-10-31 加入順路搜尋（A→B、繞路時間）與關鍵字搜尋；類別按鈕改緊湊（測試模式跑過）
- 2026-10-31 加入吃的類別的類型篩選按鈕（測試模式跑過）
- 2026-10-31 完成第一版：全部類別、定位／地址、開車走路切換、篩選排序、料理類型標籤、PWA；測試模式下跑過無錯誤

## 下一步
- 使用者在手機貼上 Google 金鑰（已建好、已限制網址）與 Claude 金鑰，實測真實資料與 AI
- 手機實測真實資料（EIS 另開私人 repo，不要和本專案放一起）
- 依實測調整：類別關鍵字、料理類型判斷準確度
- 實測確認順路 API 的 routingSummaries 真的回傳兩段 legs（起點→店、店→終點），否則繞路時間要改算法
- 之後可加：政府公廁開放資料、收藏清單
