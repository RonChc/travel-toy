# 群組找人（第一版）設計摘要

2026-11-21 老闆決定：①家人可用老闆的 Google／Claude 金鑰、朋友不行 ②後台用一台一直開著的電腦自架 ③出遊時間未定（先做到能實測）。

## 架構
- 前端：`👥 群組` 分頁（`js/group.js`、`js/gateway.js`；`api.js`／`ai.js` 支援代轉）。
- 後台：`server/`（Node 24 `node:sqlite` ＋ npm `web-push`）。啟動、.env、通道步驟見 [server/README.md](../server/README.md)。
- 金鑰只放後台 `server/.env`；家人手機呼叫 `/api/proxy/*`，後台確認是「家人」才轉送給 Google／Claude。朋友回 403 `friend_no_proxy`，畫面提示「請自己輸入金鑰」。自己有輸入金鑰的人照舊直連（優先於代轉）。
- 建立群組要「建立暗號」（.env `GROUP_CREATE_CODE`）：管理員固定是家人，否則任何人建群組就能用老闆金鑰。

## 後台 API（皆 JSON；`Authorization: Bearer <權杖>`，Claude SDK 用 `x-api-key`）
| 路徑 | 說明 |
|---|---|
| `POST /api/groups` | 建群組（要暗號）→ 管理員權杖＋邀請碼 |
| `POST /api/invite/info`、`/api/join` | 看邀請資訊、加入（預設朋友） |
| `GET /api/state` | 我、群組、成員位置、待回覆的找人、未看的回覆（App 每 5 秒輪詢） |
| `POST /api/location` | 「我在這」更新位置（不推播） |
| `PUT／DELETE /api/push`、`GET /api/push/key` | 登記／取消推播訂閱、取公鑰 |
| `POST /api/find` | `{targetId}` 或 `{all:true}` → 推播「〇〇 問你在哪裡？」 |
| `PUT /api/finds/:id/photo`、`POST .../reply`、`POST .../seen`、`GET .../photo` | 被問的人傳照片、回覆；發問者標已讀、取照片 |
| `PATCH／DELETE /api/members/:id`、`POST /api/invite/reset`、`DELETE /api/group`、`DELETE /api/me` | 管理員改身分／踢人／重發邀請碼／解散；成員離開 |
| `POST /api/proxy/google/{places/searchNearby,places/searchText,routes/computeRouteMatrix,routes/computeRoutes}`、`/api/proxy/anthropic/v1/messages` | 金鑰代轉（白名單） |

## 注意事項（維護時別踩）
- 邀請連結資訊放 `#` 後面（`#join=…&server=…`），不會送到 GitHub；找人通知網址是 `?find=<id>&kind=ask|reply`（只有代號）。
- 位置只在使用者按「我在這」或回覆找人時上傳，App 不會自動回報位置。
- 推播（Web Push）在 iPhone 要「加入主畫面」＋iOS 16.4 以上；App 開著時改由輪詢跳視窗＋Web Audio 提示音。
- `server/e2e/run.mjs` 用 CDP `deliverPushMessage` 把後台推播送進瀏覽器 Service Worker；真正經 FCM／APNs 的傳輸要在真機實測。
- 家人用 Claude 代轉時，「AI 整理招牌」也會用掉每日次數（預設 50）。
