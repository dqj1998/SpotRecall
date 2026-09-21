import { useEffect, useMemo, useRef, useState, useCallback } from 'preact/hooks';
import type { TimelineBucket, SearchHit, IndexStatus } from '@shared/types';
import { LANGS } from '@shared/i18n';
import { useI18n } from './useI18n';

interface FlatItem {
  hit: SearchHit;
  rank: number;
}

function flatten(buckets: TimelineBucket[]): FlatItem[] {
  const out: FlatItem[] = [];
  let rank = 0;
  for (const b of buckets) for (const hit of b.items) out.push({ hit, rank: rank++ });
  return out;
}

function relTime(ts: number, lang: string): string {
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    const diff = ts - Date.now();
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (Math.abs(diff) < hour) return rtf.format(Math.round(diff / min), 'minute');
    if (Math.abs(diff) < day) return rtf.format(Math.round(diff / hour), 'hour');
    const days = Math.round(diff / day);
    if (Math.abs(days) < 30) return rtf.format(days, 'day');
    return rtf.format(Math.round(days / 30), 'month');
  } catch {
    return '';
  }
}

function faviconFor(url: string): string {
  // Chrome's LOCAL favicon cache — no network, no domain leak to third parties.
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '32');
  return u.toString();
}

const PANEL_URL = 'src/ui/options.html';

export function PaletteApp({ onClose }: { onClose: () => void }) {
  const { lang, setLang, t } = useI18n();
  const [query, setQuery] = useState('');
  const [buckets, setBuckets] = useState<TimelineBucket[]>([]);
  const [stage, setStage] = useState<1 | 2>(1);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryIdRef = useRef('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flat = useMemo(() => flatten(buckets), [buckets]);
  const rankOf = useMemo(() => {
    const m = new Map<string, number>();
    flat.forEach((f) => m.set(f.hit.id, f.rank));
    return m;
  }, [flat]);

  useEffect(() => {
    inputRef.current?.focus();
    chrome.runtime.sendMessage({ type: 'TELEMETRY', event: { type: 'palette_open' } }).catch(() => {});
    const refreshStatus = () =>
      chrome.runtime
        .sendMessage({ type: 'GET_INDEX_STATUS' })
        .then((s: IndexStatus) => s && setStatus(s))
        .catch(() => {});
    refreshStatus();
    const iv = setInterval(refreshStatus, 3000);

    const onUpdate = (msg: { type?: string; queryId?: string; buckets?: TimelineBucket[] }) => {
      if (msg?.type === 'SEARCH_RESULTS_UPDATE' && msg.queryId === queryIdRef.current) {
        setBuckets(msg.buckets ?? []);
        setStage(2);
      }
      return undefined;
    };
    chrome.runtime.onMessage.addListener(onUpdate);
    return () => {
      clearInterval(iv);
      chrome.runtime.onMessage.removeListener(onUpdate);
      chrome.runtime.sendMessage({ type: 'TELEMETRY', event: { type: 'palette_close' } }).catch(() => {});
    };
  }, []);

  const runSearch = useCallback((text: string) => {
    const qid = crypto.randomUUID();
    queryIdRef.current = qid;
    setStage(1);
    if (!text.trim()) {
      setBuckets([]);
      return;
    }
    chrome.runtime
      .sendMessage({ type: 'SEARCH_QUERY', queryId: qid, text })
      .then((resp: { queryId: string; buckets: TimelineBucket[] }) => {
        if (resp && resp.queryId === queryIdRef.current) setBuckets(resp.buckets ?? []);
      })
      .catch(() => {});
  }, []);

  const onInput = (e: Event) => {
    const text = (e.target as HTMLInputElement).value;
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(text), 150);
  };

  const open = (hit: SearchHit) => {
    chrome.runtime
      .sendMessage({
        type: 'OPEN_RESULT',
        queryId: queryIdRef.current,
        resultVersion: stage,
        rank: rankOf.get(hit.id) ?? 0,
        id: hit.id,
        url: hit.url,
      })
      .catch(() => {});
    onClose();
  };

  const openPanel = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_URL) }).catch(() => {});
    onClose();
  };

  const semanticOff = status ? !status.semanticEnabled : false;
  const statusText = !status
    ? ''
    : status.paused
      ? t('statusPaused')
      : status.pending > 0
        ? t('statusIndexing', { count: status.pending })
        : t('statusAllIndexed', { count: status.total });

  return (
    <div class="wrap">
      <div class="card">
        <div class="topbar">
          <span class="app-name">{t('appName')}</span>
          <div class="topbar-actions">
            <div class="lang-seg" role="group" aria-label={t('langLabel')}>
              {LANGS.map((l) => (
                <button key={l.code} class={l.code === lang ? 'on' : ''} onClick={() => setLang(l.code)}>
                  {l.label}
                </button>
              ))}
            </div>
            <button class="panel-btn" onClick={openPanel}>
              {t('openPanel')}
            </button>
          </div>
        </div>

        <div class="searchbar">
          <svg class="s-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            class="input"
            placeholder={t('searchPlaceholder')}
            value={query}
            onInput={onInput}
          />
          <span class="mode-chip" title={stage === 2 ? t('modeSemanticTip') : t('modeKeywordTip')}>
            {stage === 2 ? t('modeSemantic') : t('modeKeyword')}
          </span>
        </div>

        {semanticOff && (
          <div class="hint" onClick={openPanel}>
            {t('semanticHintOff')}
          </div>
        )}

        <div class="list">
          {flat.length === 0 ? (
            <div class="empty">{query ? t('emptyNoResults') : t('emptyStart')}</div>
          ) : (
            buckets.map((b) => (
              <div key={b.key}>
                {b.label && <div class="bucket-label">{b.label}</div>}
                {b.items.map((hit) => (
                  <div key={hit.id} class="row" onClick={() => open(hit)}>
                    <img
                      class="favicon"
                      src={hit.favicon || faviconFor(hit.url)}
                      onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                    />
                    <div class="row-main">
                      <div class="row-title">{hit.title}</div>
                      <div class="row-url">{hit.domain}</div>
                    </div>
                    <div class="row-time">{relTime(hit.lastVisited, lang)}</div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        <div class="footer">
          <span>{statusText}</span>
          {status && status.pending > 0 && (
            <span class="status-dots">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
