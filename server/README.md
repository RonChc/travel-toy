# 旅遊玩意 群組後台（server/）

「👥 群組」分頁用的後台：放在一台**一直開著的電腦**上。負責

- 群組、成員、位置、找人請求與照片（SQLite + 照片檔，存在 `server/data/`）
- 找人時發 **Web Push** 推播（「〇〇 問你在哪裡？」「〇〇 回覆了」）
- **金鑰代轉**：老闆的 Google／Claude 金鑰只放在這台電腦的 `.env`，**家人**的手機透過後台呼叫；**朋友**不行

> 前端（GitHub Pages 上的 App）不需要改部署；使用者在 App「⚙️ 設定」填「群組伺服器網址」即可。

## 需求

- Node.js 24 以上（用內建 `node:sqlite`，會看到一行 ExperimentalWarning，正常）
- 專案內 npm 套件：`web-push`（推播）。`playwright-core` 只有跑端對端測試才用。

## 1. 安裝與第一次設定

```powershell
cd server
npm install
npm run setup        # 產生 .env：隨機的建立暗號＋推播（VAPID）金鑰；已存在不會覆蓋
```

然後用文字編輯器打開 `server/.env`，填：

| 變數 | 說明 |
|---|---|
| `GROUP_CREATE_CODE` | 建立群組的暗號（setup 已隨機產生，記下來；建群組時要輸入）。**至少 12 個字元，太短後台會拒絕啟動**。沒有它，任何知道網址的人都能建群組當管理員、進而用你的金鑰 |
| `GOOGLE_API_KEY` | Google Places／Routes 金鑰（只放這裡） |
| `GOOGLE_REFERER` | 目前的 Google 金鑰限制網址，後台代呼叫時會帶 `Referer: https://ronchc.github.io/`（預設值，不用改）。**建議**之後另開一把「限制 IP」給後台專用的金鑰，再把 `GOOGLE_REFERER` 清空（見下方「Google 金鑰」） |
| `ANTHROPIC_API_KEY` | Claude 金鑰（只放這裡）。到 Claude Console 設每月上限 |
| `CLAUDE_DAILY_LIMIT` | 每位家人每天呼叫 Claude 次數，所有模型合計（預設 50）。`GOOGLE_DAILY_LIMIT` 預設 500 |
| `CLAUDE_OPUS_DAILY_LIMIT` | 其中 Opus（較貴）另外限制，每位每天（預設 20，也會計入上面的總次數）。App 的「AI 幫我挑」「AI 行程」用 Opus；想更省可調低，或從 `ALLOWED_CLAUDE_MODELS` 拿掉 Opus（App 的 AI 功能就會被拒） |
| `CLAUDE_MAX_TOKENS` | 單次 Claude 請求 `max_tokens` 上限，**請求一定要帶**（預設 16000）。App 目前用 8000／16000 |
| `ALLOWED_CLAUDE_BETAS` | 允許轉送的 `anthropic-beta` 值，其餘丟掉（預設 `server-side-fallback-2026-07-01`，App 的「被拒答時改用備用模型」要用） |
| `VAPID_SUBJECT` | 填 `mailto:你的信箱`（推播服務要求有聯絡方式） |
| `GROUP_TTL_HOURS` | 群組幾小時後自動解散並刪除全部資料（預設 168＝7 天） |
| `TRUST_PROXY` | 來源 IP 要相信誰：`none`（預設，直接對外或本機）、`cloudflare`、`tailscale`，**其餘（包含舊的 `1`）後台會拒絕啟動**（見下方 §4） |
| `DEV` | 設 `1` 才允許 `http://localhost:*` 當前端來源（只在自己電腦開發時用，正式上線不要開） |

`.env`、`data/`、VAPID 私鑰都已在 `.gitignore`，**不會進 git**（這個 repo 是公開的）。

### 只想重新產生推播金鑰

```powershell
npm run vapid      # 印出一組新的 VAPID_PUBLIC_KEY／VAPID_PRIVATE_KEY，自己貼進 .env
```
換金鑰後，所有人要重新按「開啟通知」。

## 2. 啟動

```powershell
npm start          # 預設 http://127.0.0.1:8787，只開給本機
```

啟動後檢查：瀏覽器開 <http://127.0.0.1:8787/api/health> 應該看到 `{"ok":true,"push":true}`。

要讓電腦開機就自動跑：用「工作排程器」建立工作，觸發程序選「登入時」，動作是 `node src/index.js`，「起始位置」填 `server` 資料夾完整路徑（**不要**用系統層級的設定檔改動；這一步由老闆決定要不要做）。

## 3. 本機開發測試（不對外）

```powershell
node ..\tools\serve.mjs          # 前端 http://localhost:5173
# 另一個視窗
npm start                        # 後台 http://127.0.0.1:8787
```
App「⚙️ 設定」→ 群組伺服器網址填 `http://127.0.0.1:8787`（只有 localhost／127.0.0.1 可以用 http，其他網址一律要 https）。
CORS 預設只允許 `https://ronchc.github.io`；本機開發要在 `.env` 設 `DEV=1`，才會多允許 `http://localhost:*`（其他來源用 `EXTRA_ORIGINS`）。

## 4. 之後要讓手機從外面連進來（只寫步驟，**這份工單沒有實際開**）

手機要用推播、定位，網址必須是 **https**。兩種方法擇一，都是「通道從本機連出去，後台本身仍只聽 127.0.0.1」，所以**不用在路由器開 port**：

### 方法 A：Tailscale Funnel

1. 這台電腦和手機都裝 Tailscale、登入同一帳號；在 Tailscale 管理頁開啟 HTTPS 與 Funnel。
2. 後台維持 `npm start`。
3. 管理員在這台電腦執行：`tailscale funnel 8787`（會印出 `https://電腦名稱.tailnet名稱.ts.net`）。
4. `.env` 設 `TRUST_PROXY=tailscale`（只取 `X-Forwarded-For` **最右邊**那個 IP，那是 Funnel 自己附加的；使用者自己塞在左邊的假 IP 沒用），重開後台。
5. App「⚙️ 設定」→ 群組伺服器網址填那個 https 網址。

### 方法 B：Cloudflare 通道（cloudflared）

1. 有自己的網域並放在 Cloudflare：安裝 `cloudflared`，`cloudflared tunnel login`。
2. `cloudflared tunnel create travel-toy`，`cloudflared tunnel route dns travel-toy group.你的網域`。
3. 設定檔 `config.yml` 的 ingress 指向 `http://127.0.0.1:8787`，執行 `cloudflared tunnel run travel-toy`。
   （沒有網域也可以先用 `cloudflared tunnel --url http://127.0.0.1:8787` 取得臨時的 `*.trycloudflare.com` 網址，但每次重開網址會變，只適合短期測試。）
4. `.env` 設 `TRUST_PROXY=cloudflare`（只信 `CF-Connecting-IP`，Cloudflare 會覆寫這個標頭），重開後台。
5. App「⚙️ 設定」填 https 網址。

> `TRUST_PROXY` 決定「頻率限制把誰當成同一個人」。只有後台真的**只能經由那條通道**連到時才設 `cloudflare`／`tailscale`（後台維持只聽 `127.0.0.1`）；沒有通道、或後台也能被直接連到時要用 `none`，否則任何人都能自己帶假標頭繞過鎖定。
> 設了 `cloudflare`／`tailscale` 時，`HOST` 必須是 `127.0.0.1`（或 `::1`／`localhost`），否則後台會拒絕啟動並說明原因。
> 不要設 `1`、`true` 之類的舊寫法，那等於「信使用者帶的標頭」，後台會直接拒絕啟動。IPv6 來源只看前 64 位元（同一段視為同一個人）。

> ⚠️ **`server/` 資料夾不要放在雲端同步資料夾**（OneDrive、Google 雲端硬碟、Dropbox、iCloud 等）。`.env`（金鑰、建立暗號、VAPID 私鑰）、`data/`（群組資料庫、照片）會被同步到雲端與其他裝置，等於把金鑰和位置照片交給第三方。放在不同步的本機資料夾（例如 `C:	ravel-toyserver`）。

### 手機端

- iPhone：Safari 開 App → 分享 →「加入主畫面」→ 從主畫面開啟 → 群組分頁按「開啟通知」（iOS 16.4 以上才支援 Web Push）。
- Android：Chrome 直接允許通知即可。

## 5. 使用流程

1. 老闆（管理員）在 App → 群組 →「建立群組」→ 輸入暗號、名字、表情 → 拿到邀請連結＋QR。
2. 同行的人開連結（或掃 QR）→ 輸入名字選表情 → 加入。**預設是「朋友」**。
3. 管理員在成員清單把家人改成「家人」→ 對方立刻能在附近／順路／AI 用老闆的金鑰（由後台代轉）。改回「朋友」或「踢出」立刻失效。
4. 找人：成員旁按「📣 找他」或上方「找全部人」→ 對方收到推播 → 點開 → 送出位置＋樓層＋照片＋一句話 → 你收到「〇〇 回覆了」，點開看地圖和照片。
5. 群組 7 天自動到期；管理員也可隨時「解散」。到期或解散時，成員、位置、找人紀錄、照片檔案全部刪除。

## 安全設計重點

- 權杖：`crypto.randomBytes(32)`（256 位元），後台只存 SHA-256 雜湊；每個 API 都檢查權杖＋所屬群組，查詢一律帶 `group_id`。
- 邀請連結把邀請碼放在網址 `#` 後面（瀏覽器不會送給 GitHub 主機），開啟後立刻從網址列移除。
- 金鑰只在 `.env` → 後台記憶體 → 轉送給 Google／Claude；回應會順手遮掉金鑰字串；家人手機、`localStorage`、後台回應都看不到金鑰。
- 代轉白名單：Places `searchNearby`／`searchText`、Routes `computeRouteMatrix`／`computeRoutes`、Anthropic `/v1/messages`。其他路徑一律 403。
- **Claude 請求不是原樣轉送，而是後台解析驗證後用白名單欄位重組再送**（`JSON.stringify` 重組後的物件，不送原始內容，所以重複的鍵、多餘的欄位都穿不過去）：只留 `model`、`max_tokens`、`system`、`messages`、`tools`、`tool_choice`、`stream`、`temperature`、`output_config`、`fallbacks`；`model` 必須在 `ALLOWED_CLAUDE_MODELS`、`max_tokens` 必填且 ≤ `CLAUDE_MAX_TOKENS`（預設 16000）；`mcp_servers`、`container`、`service_tier` 出現就 400；`tools` 只收 App 自己的自訂工具（有 `type` 且不是 `custom` 的內建工具，如 `web_search`、`code_execution`、`bash` 一律拒絕）；`messages` 的內容區塊只收文字／工具呼叫／工具結果；`fallbacks` 只能是 `"default"`；`anthropic-beta` 只留 `ALLOWED_CLAUDE_BETAS` 內的值。Opus 另有較低的每日次數。
- 每人每天次數上限（Claude／Google 各自計算）。
- 照片：只收 jpeg／png／webp（驗檔頭，不只看 Content-Type）、2MB 上限、隨機檔名、讀取也要權杖、不同人不能看別人的。
- 推播訂閱端點只接受 FCM／Mozilla／Apple／Windows 的推播服務網址（避免後台被拿去連任意網址）。
- 頻率限制：加入、找人、上傳、代轉、更新位置、猜錯權杖／邀請碼／暗號。**建立群組的額度只算「猜錯建立暗號」**（每個 IP 每小時 5 次，猜錯太多次連猜對也先擋；猜對的不佔額度，一個人亂試只會鎖住他自己的 IP）。限速表最多 10 萬筆，超過丟最舊的。
- 找人：同一對（發問者→目標）60 秒內不能再問（`FIND_PAIR_COOLDOWN_SECONDS`）；「找全部人」依人數計入額度（`RL_FIND`，預設每人每分鐘 40）。
- 踢人時後台自動重發邀請碼，被踢的人手上的舊邀請連結失效。
- 前端：所有放進 `href` 的網址先檢查是 `https:`；邀請連結的伺服器和手機已設定的不同時，先跳確認視窗（還沒送出邀請碼）。
- 比對建立暗號：兩邊先 SHA-256 再 `timingSafeEqual`。
- 畫面輸出一律 `textContent`／DOM 建立，不用 `innerHTML` 放名字或留言。

## Google 金鑰怎麼選

- **方案 1（預設，不用改）**：沿用目前「限制網址」的金鑰，後台代呼叫時帶 `Referer: https://ronchc.github.io/`，Google 會當成來自 GitHub Pages。缺點：這把金鑰同時放在老闆手機設定裡；任何人拿到金鑰＋知道網址限制就能偽造 Referer 盜用，所以只放後台比較好。
- **方案 2（較安全，建議）**：到 Google Cloud 另建一把**專給後台**的金鑰，限制「IP 位址」（這台電腦對外的 IP），只開 Places API (New) 與 Routes API；把 `GOOGLE_REFERER=` 清空。網址限制的那把留給老闆自己手機直連用。

## 測試

```powershell
npm test                # 後台自動測試（node --test，共 65 項，約 2 秒）
node e2e/run.mjs        # 端對端：真的開兩個瀏覽器走完整流程並截圖（需要 Chromium，截圖存 e2e/out/）
```

`npm test` 涵蓋：權限（朋友 403、家人可用、改回朋友馬上失效、踢人失效）、金鑰不外洩、代轉路徑白名單與每日上限、解散／到期後資料與照片檔案刪除、跨群組隔離、亂猜權杖、頻率限制、CORS、照片驗證；以及 `test/hardening.test.js`（資安修正）：假 `CF-Connecting-IP`／`X-Forwarded-For` 不能繞過鎖定、Claude 請求白名單（`mcp_servers`、內建工具、未知 beta、超大 `max_tokens`、重複 `model` 鍵）、Opus 每日次數、找人冷卻、踢人換邀請碼、暗號長度、CORS 的 `DEV`、前端網址檢查。
