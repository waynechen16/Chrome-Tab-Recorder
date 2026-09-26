# 文件版本歷程

## v1.3 — 2026-09-26

- M3 實作完成；第 10 節更新進度。
- 第 8 節補充「跟隨分頁」解析度的計算方式、設定頁行為，以及指定資料夾權限過期時的處理與退回下載資料夾的規則。

## v1.2 — 2026-09-26

- M2 實作完成；第 10 節更新進度。
- 第 6 節新增兩項設計規則：不在最小化視窗跳麥克風權限提示；聲音回放被暫停時不混入麥克風。

## v1.1 — 2026-09-26

- M1 實作完成；第 10 節加註進度，第 12 節加註 A1／A2／A4 的驗證結果。
- Manifest 權限新增 `notifications`（存檔完成通知）。
- `getMediaStreamId` 不帶 `consumerTabId`，避開假設 A2。
- Recorder Window 開啟位置若超出螢幕，改由 Chrome 自行決定位置。

## v1.0 — 2026-09-26

- 初版 implementation plan。
- 決策定案：`chrome.tabCapture` 一鍵錄分頁、WebM 輸出、麥克風可隨時開關、可指定儲存資料夾（預設下載）、純個人使用。
- Recorder Window 改為不搶焦點、錄製開始後自動最小化，popup 可召回。
- 新增錄製狀態標示：目標分頁標題 / favicon、Recorder Window、extension badge 三處同步。
