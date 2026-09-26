# Chrome Tab Recorder

錄製 Chrome 分頁影音（例如 Google Meet 線上課程）的 Chrome extension（Manifest V3，個人使用）。

目前進度：**M1 完成**（一鍵錄分頁、暫停／繼續、自動存到下載資料夾、錄製狀態標示）。麥克風混音（M2）與指定資料夾（M3）尚未實作。

## 安裝（載入未封裝擴充功能）

需要 Node.js 20 以上。

```bash
npm install
npm run build
```

1. Chrome 開啟 `chrome://extensions`，右上角打開「開發人員模式」。
2. 按「載入未封裝項目」，選擇 `dist/chrome-mv3` 資料夾。
3. 建議把 Tab Recorder 圖示釘選到工具列。

之後改了程式碼，重新 `npm run build`，再到 `chrome://extensions` 按 Tab Recorder 的重新載入即可。**錄製中不要重新載入 extension**，否則錄製會中斷。

## 使用方式

1. 在要錄的分頁（例如 Meet 課程）點工具列的 Tab Recorder 圖示，按「開始錄製此分頁」。
2. 右下角會出現一個小的錄製視窗，開始錄製後自動最小化；錄製中**不要關閉它**。
3. 錄製狀態會同時顯示在：
   - Meet 分頁標題前綴 `● REC │`（暫停時 `‖ PAUSED │`）與紅點／黃色 favicon
   - 工具列圖示 badge：紅底 `REC`、黃底 `‖`
   - 錄製視窗的標題與計時
4. 再點圖示可暫停／繼續、停止並存檔。關閉被錄的分頁也會自動停止並存檔。
5. 檔案存到下載資料夾，檔名為 `{分頁標題}_{日期}_{時間}.webm`，存檔後會跳出通知。

若錄製視窗顯示「瀏覽器暫停了聲音回放」，打開錄製視窗點一下提示即可恢復聽到課程聲音（錄音本身不受影響）。

錄製他人參與的會議或課程前，請先取得同意。

## 開發

```bash
npm run dev        # WXT 開發模式（會開一個載入 extension 的 Chrome）
npm test           # 單元測試（WebM Duration 修補用真實 Chromium 錄出的檔案驗證，需 ffprobe）
npm run typecheck
```

## 文件

- [Implementation Plan](docs/implementation-plan.md)
- [文件版本歷程](docs/CHANGELOG.md)
- [M1 驗收步驟](docs/m1-test-guide.md)
