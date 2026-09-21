// Capture content script (dev plan §3, §12.1). Runs in every frame at
// document_idle. Identity (tabId/frameId/documentId) is read authoritatively by
// the SW from the MessageSender — this script never self-reports it.

(() => {
  let isCommitted = false;
  let stopped = false;
  let fgAccumMs = 0;
  let fgSince: number | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  function extractClean(): string {
    // Prefer the main content region; falls back to <body>. This alone removes
    // most site chrome (Amazon-style nav/menus that otherwise dominate the text).
    const root =
      (document.querySelector('main, article, [role="main"]') as HTMLElement) || document.body;
    if (!root) return '';
    const clone = root.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll(
        'script,style,noscript,svg,iframe,nav,header,footer,aside,form,button,' +
          'input,textarea,select,[role="navigation"],[role="banner"],[role="contentinfo"],' +
          '[aria-hidden="true"],[hidden],[type="password"],[autocomplete^="cc-"],[autocomplete="one-time-code"]',
      )
      .forEach((el) => el.remove());
    // Drop repeated short lines (nav labels, breadcrumbs) that dilute the signal.
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const line of (clone.innerText || '').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (t.length < 40 && seen.has(t)) continue;
      seen.add(t);
      lines.push(t);
    }
    return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
  }

  function commitPage(): void {
    if (isCommitted || stopped) return;
    isCommitted = true;
    teardown();
    chrome.runtime
      .sendMessage({ type: 'COMMIT_PAGE_RECORD', data: { url: location.href, content: extractClean() } })
      .catch(() => {});
  }

  const onInteract = () => commitPage();
  const onScroll = () => {
    if (window.scrollY > window.innerHeight * 0.5) commitPage();
  };

  function tickForeground(): void {
    const active = document.visibilityState === 'visible' && document.hasFocus();
    if (active && fgSince === null) fgSince = Date.now();
    if (!active && fgSince !== null) {
      fgAccumMs += Date.now() - fgSince;
      fgSince = null;
    }
    const total = fgAccumMs + (fgSince ? Date.now() - fgSince : 0);
    if (total >= 15000) commitPage();
  }

  function teardown(): void {
    window.removeEventListener('click', onInteract, true);
    window.removeEventListener('keydown', onInteract, true);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', tickForeground);
    if (tickTimer) clearInterval(tickTimer);
  }

  function initProvisional(): void {
    isCommitted = false;
    stopped = false;
    fgAccumMs = 0;
    fgSince = null;
    chrome.runtime
      .sendMessage({
        type: 'INIT_PROVISIONAL_RECORD',
        data: {
          url: location.href,
          title: document.title,
          description:
            document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content || '',
          domain: location.hostname,
        },
      })
      .catch(() => {});
    window.addEventListener('click', onInteract, { capture: true, once: true });
    window.addEventListener('keydown', onInteract, { capture: true, once: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', tickForeground);
    tickTimer = setInterval(tickForeground, 1000);
  }

  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === 'SPA_NAVIGATED') {
      teardown();
      initProvisional();
    } else if (msg?.type === 'STOP_CAPTURE') {
      stopped = true;
      teardown();
    }
    return undefined;
  });

  initProvisional();
})();
