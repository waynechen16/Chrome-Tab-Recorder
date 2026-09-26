import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  publicDir: 'public',
  manifest: {
    name: 'Tab Recorder',
    description: '錄製 Chrome 分頁的影像與聲音（例如 Google Meet 線上課程），輸出 WebM。',
    minimum_chrome_version: '116',
    permissions: ['tabCapture', 'activeTab', 'scripting', 'downloads', 'storage', 'tabs', 'notifications'],
    action: {
      default_title: 'Tab Recorder',
    },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  },
});
