/**
 * Recording indicators (plan §8): the captured tab's title + favicon, the
 * recorder window's own title + favicon, and the toolbar badge.
 */

export type IndicatorMode = 'recording' | 'paused' | 'off';

const svg = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`)}`;

export const FAVICON: Record<Exclude<IndicatorMode, 'off'>, string> = {
  recording: svg('<circle cx="16" cy="16" r="13" fill="#e53935" stroke="#fff" stroke-width="3"/>'),
  paused: svg(
    '<circle cx="16" cy="16" r="14" fill="#f9a825"/><rect x="10" y="9" width="4.5" height="14" rx="1" fill="#fff"/><rect x="17.5" y="9" width="4.5" height="14" rx="1" fill="#fff"/>',
  ),
};

export const TITLE_PREFIX: Record<Exclude<IndicatorMode, 'off'>, string> = {
  recording: '● REC │ ',
  paused: '‖ PAUSED │ ',
};

/**
 * Runs inside the captured page (isolated world) via chrome.scripting.
 * Must be self-contained: it is serialised, so no closures over module scope.
 * Only touches <title> and favicon <link>s — nothing visible in the page,
 * because the page itself is what is being recorded.
 */
export function applyPageIndicator(mode: IndicatorMode, prefixes: Record<string, string>, icons: Record<string, string>): void {
  type Store = {
    mode: IndicatorMode;
    observer?: MutationObserver;
    ours?: HTMLLinkElement;
    stashed: HTMLLinkElement[];
  };
  const w = window as unknown as { __tabRecorderIndicator?: Store };
  const st: Store = (w.__tabRecorderIndicator ??= { mode: 'off', stashed: [] });
  const allPrefixes = Object.values(prefixes);
  const strip = (t: string) => {
    for (const p of allPrefixes) if (t.startsWith(p)) return t.slice(p.length);
    return t;
  };

  const applyTitle = () => {
    if (st.mode === 'off') return;
    const want = (prefixes[st.mode] ?? '') + strip(document.title);
    if (document.title !== want) document.title = want;
  };

  const stashIcons = () => {
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]').forEach((l) => {
      if (l !== st.ours) {
        st.stashed.push(l);
        l.remove();
      }
    });
  };

  const applyIcon = () => {
    if (st.mode === 'off') return;
    stashIcons();
    if (!st.ours) {
      st.ours = document.createElement('link');
      st.ours.rel = 'icon';
      st.ours.dataset.tabRecorder = '1';
    }
    st.ours.href = icons[st.mode] ?? '';
    if (!st.ours.isConnected) (document.head ?? document.documentElement).appendChild(st.ours);
  };

  st.mode = mode;
  if (mode === 'off') {
    st.observer?.disconnect();
    st.observer = undefined;
    document.title = strip(document.title);
    st.ours?.remove();
    st.ours = undefined;
    const head = document.head ?? document.documentElement;
    st.stashed.forEach((l) => head.appendChild(l));
    st.stashed = [];
    return;
  }

  applyTitle();
  applyIcon();
  if (!st.observer) {
    // The page (e.g. Meet) rewrites its title and favicon; re-apply ours.
    st.observer = new MutationObserver(() => {
      st.observer?.disconnect();
      applyTitle();
      applyIcon();
      st.observer?.observe(document.head ?? document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    st.observer.observe(document.head ?? document.documentElement, { subtree: true, childList: true, characterData: true });
  }
}

/** Apply the indicator to a tab; failures (tab gone, no access) are ignored. */
export async function setTabIndicator(tabId: number, mode: IndicatorMode): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: applyPageIndicator,
      args: [mode, TITLE_PREFIX, FAVICON],
    });
  } catch (e) {
    console.debug('Tab indicator not applied:', (e as Error).message);
  }
}

export async function setBadge(mode: IndicatorMode | 'error'): Promise<void> {
  const cfg = {
    recording: { text: 'REC', color: '#e53935' },
    paused: { text: '‖', color: '#f9a825' },
    error: { text: '!', color: '#757575' },
    off: { text: '', color: '#000000' },
  }[mode];
  await chrome.action.setBadgeText({ text: cfg.text });
  await chrome.action.setBadgeBackgroundColor({ color: cfg.color });
  if (mode !== 'off') await chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
}
