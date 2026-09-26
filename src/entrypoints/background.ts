/**
 * Service worker — stateless coordinator (plan §2, §4).
 * All state lives in chrome.storage.session because this worker can be
 * stopped at any time.
 */
import { defineBackground } from 'wxt/utils/define-background';
import { setBadge, setTabIndicator, type IndicatorMode } from '@/lib/indicator';
import {
  send,
  type BackgroundMessage,
  type CommandResponse,
  type InitResponse,
  type RecorderCommand,
} from '@/lib/messages';
import { loadSettings } from '@/lib/settings';
import { canTransition, formatBytes, formatDuration, getState, resetState, setState } from '@/lib/state';

const RECORDER_WIDTH = 380;
const RECORDER_HEIGHT = 300;

export default defineBackground({
  type: 'module',
  main() {
    chrome.runtime.onMessage.addListener((msg: BackgroundMessage, sender, sendResponse) => {
      if (msg?.to !== 'background') return false;
      handle(msg, sender).then(sendResponse, (e: Error) =>
        sendResponse({ ok: false, code: 'CAPTURE_FAILED', message: e.message } satisfies CommandResponse),
      );
      return true; // async response
    });

    chrome.tabs.onRemoved.addListener(async (tabId) => {
      const s = await getState();
      if (tabId === s.targetTabId && (s.phase === 'recording' || s.phase === 'paused')) {
        await toRecorder({ to: 'recorder', type: 'STOP' });
      }
    });

    // Re-apply the title/favicon indicator after the captured page reloads.
    chrome.tabs.onUpdated.addListener(async (tabId, info) => {
      if (info.status !== 'complete') return;
      const s = await getState();
      if (tabId === s.targetTabId && (s.phase === 'recording' || s.phase === 'paused')) {
        await setTabIndicator(tabId, s.phase);
      }
    });

    chrome.windows.onRemoved.addListener(async (windowId) => {
      const s = await getState();
      if (windowId !== s.recorderWindowId || s.phase === 'idle') return;
      // The recorder window vanished without reporting DONE.
      if (s.targetTabId !== undefined) await setTabIndicator(s.targetTabId, 'off');
      if (s.phase === 'error') {
        await setState({ recorderWindowId: undefined });
        return;
      }
      await setBadge('error');
      await resetState({
        phase: 'error',
        lastError: '錄製視窗被關閉，錄製已中斷。已錄到的內容保留在 extension 儲存空間（M4 將提供修復功能）。',
      });
    });

    // Browser restarted with stale state: nothing can still be recording.
    chrome.runtime.onStartup.addListener(async () => {
      await resetState();
      await setBadge('off');
    });
  },
});

async function toRecorder(cmd: RecorderCommand): Promise<void> {
  await send(cmd);
}

async function applyIndicators(mode: IndicatorMode, tabId?: number): Promise<void> {
  await setBadge(mode);
  if (tabId !== undefined) await setTabIndicator(tabId, mode);
}

/** Place the recorder window at the bottom-right of the current browser window. */
async function recorderBounds(): Promise<{ left?: number; top?: number }> {
  try {
    const w = await chrome.windows.getLastFocused();
    if (w.left === undefined || w.top === undefined || !w.width || !w.height) return {};
    return {
      left: Math.max(0, w.left + w.width - RECORDER_WIDTH - 24),
      top: Math.max(0, w.top + w.height - RECORDER_HEIGHT - 24),
    };
  } catch {
    return {};
  }
}

async function handle(msg: BackgroundMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'START': {
      const s = await getState();
      if (s.phase !== 'idle' && s.phase !== 'error') {
        return { ok: false, code: 'ALREADY_RECORDING', message: `已在錄製「${s.targetTitle ?? ''}」` } satisfies CommandResponse;
      }
      await resetState({ phase: 'starting', targetTabId: msg.tabId, targetTitle: msg.tabTitle, micOn: msg.micOn });
      let win: chrome.windows.Window | undefined;
      const opts: chrome.windows.CreateData = {
        url: chrome.runtime.getURL('/recorder.html'),
        type: 'popup',
        focused: false,
        width: RECORDER_WIDTH,
        height: RECORDER_HEIGHT,
      };
      try {
        try {
          win = await chrome.windows.create({ ...opts, ...(await recorderBounds()) });
        } catch {
          // Bounds rejected (e.g. off-screen on a multi-monitor setup): let Chrome place it.
          win = await chrome.windows.create(opts);
        }
      } catch (e) {
        await resetState();
        return { ok: false, code: 'CAPTURE_FAILED', message: `無法開啟錄製視窗：${(e as Error).message}` } satisfies CommandResponse;
      }
      await setState({ recorderWindowId: win?.id });
      return { ok: true } satisfies CommandResponse;
    }

    case 'RECORDER_READY': {
      // The recorder window has loaded: now (and only now) get the stream id,
      // because it must be consumed within a few seconds.
      const s = await getState();
      if (s.phase !== 'starting' || s.targetTabId === undefined) {
        return { ok: false, code: 'CAPTURE_FAILED', message: '沒有等待中的錄製' } satisfies InitResponse;
      }
      if (sender.tab?.windowId !== undefined && s.recorderWindowId === undefined) {
        await setState({ recorderWindowId: sender.tab.windowId });
      }
      try {
        // No consumerTabId: the id is then usable by any page of this extension.
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: s.targetTabId });
        const tab = await chrome.tabs.get(s.targetTabId).catch(() => undefined);
        const tabSize = tab?.width && tab?.height ? { width: tab.width, height: tab.height } : undefined;
        return {
          ok: true,
          streamId,
          tabId: s.targetTabId,
          tabTitle: s.targetTitle ?? '',
          tabSize,
          micOn: s.micOn,
          settings: await loadSettings(),
        } satisfies InitResponse;
      } catch (e) {
        const message = `無法擷取此分頁：${(e as Error).message}。請在要錄的分頁上重新點擊 extension 圖示。`;
        await setBadge('error');
        await setState({ phase: 'error', lastError: message });
        return { ok: false, code: 'CAPTURE_FAILED', message } satisfies InitResponse;
      }
    }

    case 'STATUS': {
      const s = await getState();
      if (!canTransition(s.phase, msg.phase)) {
        console.warn(`Ignoring transition ${s.phase} → ${msg.phase}`);
        return;
      }
      await setState({
        phase: msg.phase,
        bytesWritten: msg.bytesWritten,
        elapsedMs: msg.elapsedMs,
        elapsedAt: Date.now(),
        audioPlaybackBlocked: msg.audioPlaybackBlocked,
        micOn: msg.micOn,
        micError: msg.micError,
        warning: msg.warning,
        attention: msg.attention,
      });

      if (msg.phase !== s.phase && (msg.phase === 'recording' || msg.phase === 'paused')) {
        await applyIndicators(msg.phase, s.targetTabId);
      }
      // First time we reach "recording" — or the user just resolved what needed
      // their attention in the window — get the window out of the way.
      const resolved = !!s.attention && !msg.attention && (msg.phase === 'recording' || msg.phase === 'paused');
      if ((s.phase === 'starting' && msg.phase === 'recording') || resolved) {
        const settings = await loadSettings();
        const needsUser = msg.audioPlaybackBlocked || !!msg.attention;
        if (settings.autoMinimize && !needsUser && s.recorderWindowId !== undefined) {
          await chrome.windows.update(s.recorderWindowId, { state: 'minimized' }).catch(() => undefined);
        }
      }
      return;
    }

    case 'DONE': {
      const s = await getState();
      await applyIndicators('off', s.targetTabId);
      await resetState({
        lastRecording: {
          fileName: msg.fileName,
          bytes: msg.bytes,
          durationMs: msg.durationMs,
          finishedAt: Date.now(),
          durationFixed: msg.durationFixed,
          savedTo: msg.savedTo,
          location: msg.location,
          fallbackReason: msg.fallbackReason,
        },
      });
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('/icon/128.png'),
        title: msg.fallbackReason ? '錄製已存檔（改存到下載資料夾）' : `錄製已存到「${msg.location}」`,
        message: `${msg.fileName}\n${formatDuration(msg.durationMs)} · ${formatBytes(msg.bytes)}`,
      });
      return;
    }

    case 'ERROR': {
      const s = await getState();
      await setBadge('error');
      if (s.targetTabId !== undefined) await setTabIndicator(s.targetTabId, 'off');
      await setState({ phase: 'error', lastError: msg.message });
      return;
    }

    case 'STOP':
    case 'PAUSE':
    case 'RESUME':
      await toRecorder({ to: 'recorder', type: msg.type });
      return { ok: true } satisfies CommandResponse;

    case 'SET_MIC': {
      const s = await getState();
      if (s.phase !== 'recording' && s.phase !== 'paused') {
        return { ok: false, code: 'MIC_FAILED', message: '目前沒有在錄製' } satisfies CommandResponse;
      }
      await toRecorder({ to: 'recorder', type: 'SET_MIC', enabled: msg.enabled });
      return { ok: true } satisfies CommandResponse;
    }

    case 'SHOW_RECORDER': {
      const s = await getState();
      if (s.recorderWindowId !== undefined) {
        await chrome.windows.update(s.recorderWindowId, { state: 'normal', focused: true });
      }
      return { ok: true } satisfies CommandResponse;
    }

    case 'ACK_ERROR': {
      const s = await getState();
      if (s.phase === 'error') {
        if (s.recorderWindowId !== undefined) await chrome.windows.remove(s.recorderWindowId).catch(() => undefined);
        await resetState();
        await setBadge('off');
      }
      return { ok: true } satisfies CommandResponse;
    }
  }
}
