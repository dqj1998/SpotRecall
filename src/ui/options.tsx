import './options.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { exportBackup, importBackup } from '@storage/backup';
import type { EventRecord } from '@shared/types';
import { LANGS } from '@shared/i18n';
import { useI18n } from './useI18n';

interface ModelStatus {
  state: string;
  backend?: string;
  vectorCount?: number;
  progress?: number;
  currentFile?: string;
  error?: string;
}
interface Settings {
  paused: boolean;
  blacklist: string[];
  retentionLimit: number;
  persistGranted: boolean;
  semanticEnabled: boolean;
  total: number;
  pending: number;
  offscreen: ModelStatus | null;
}

const send = <T,>(msg: unknown): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

interface Metrics {
  effective: number;
  ctr: number;
  openSuccess: number;
  mrr: number;
}

function computeMetrics(events: EventRecord[]): Metrics {
  const byQuery = new Map<string, EventRecord[]>();
  let openAttempt = 0;
  let openSuccess = 0;
  for (const e of events) {
    if (e.type === 'open_attempt') openAttempt++;
    if (e.type === 'open_success') openSuccess++;
    if (e.queryId) {
      const arr = byQuery.get(e.queryId) ?? [];
      arr.push(e);
      byQuery.set(e.queryId, arr);
    }
  }
  let effective = 0;
  let clicked = 0;
  let rrSum = 0;
  for (const evs of byQuery.values()) {
    const shown = evs.find(
      (e) => e.type === 'results_shown' && ((e.payload?.count as number | undefined) ?? 0) > 0,
    );
    if (!shown) continue;
    effective++;
    const click = evs.find((e) => e.type === 'result_click');
    if (click) {
      clicked++;
      rrSum += 1 / (((click.payload?.rank as number | undefined) ?? 0) + 1);
    }
  }
  return {
    effective,
    ctr: effective ? clicked / effective : 0,
    openSuccess: openAttempt ? openSuccess / openAttempt : 0,
    mrr: effective ? rrSum / effective : 0,
  };
}

function App() {
  const { lang, setLang, t } = useI18n();
  const [s, setS] = useState<Settings | null>(null);
  const [blacklistText, setBlacklistText] = useState('');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [busy, setBusy] = useState('');

  const modelLabel = (m: ModelStatus | null): string => {
    switch (m?.state) {
      case 'DOWNLOADING':
        return t('stDownloading', { p: m.progress ?? 0 });
      case 'LOADING_MODEL':
        return t('stLoading');
      case 'RESTORING_VECTORS':
        return t('stRestoring');
      case 'READY':
        return t('stReady');
      case 'ERROR':
        return `${t('stError')}: ${m.error ?? ''}`;
      default:
        return t('stIdle');
    }
  };

  const load = async () => {
    const settings = await send<Settings>({ type: 'GET_SETTINGS' });
    setS(settings);
    setModel(settings.offscreen);
    setBlacklistText((settings.blacklist ?? []).join('\n'));
    const { events } = await send<{ events: EventRecord[] }>({ type: 'GET_EVENTS' });
    setMetrics(computeMetrics(events));
  };

  useEffect(() => {
    void load();
    document.title = t('panelTitle');
    // Semantic search is on by default: ensure the model download is running.
    void send({ type: 'SET_SEMANTIC', enabled: true });
    const iv = setInterval(async () => {
      const st = await send<ModelStatus | null>({ type: 'GET_MODEL_STATUS' });
      if (st) setModel(st);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    document.title = t('panelTitle');
  }, [lang]);

  if (!s) return <div class="page">{t('loading')}</div>;

  const setPaused = async (paused: boolean) => {
    await send({ type: 'SET_PAUSED', paused });
    await load();
  };
  const saveBlacklist = async () => {
    const list = blacklistText.split('\n').map((l) => l.trim()).filter(Boolean);
    await send({ type: 'SET_BLACKLIST', blacklist: list });
    setBusy(t('savedBlocklist'));
    setTimeout(() => setBusy(''), 1500);
  };
  const doExport = async (withVectors: boolean) => {
    setBusy(t('exporting'));
    const blob = await exportBackup(withVectors, 'this-device');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spotrecall-backup-${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    setBusy('');
  };
  const doImport = async (file: File) => {
    setBusy(t('importing'));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await importBackup(bytes);
    await send({ type: 'REFRESH_CACHES' });
    setBusy(
      t('importDone', {
        imported: res.imported,
        requeued: res.requeued,
        mismatch: res.modelMismatch ? t('mismatchNote') : '',
      }),
    );
    await load();
  };
  const clearAll = async () => {
    if (!confirm(t('clearConfirm'))) return;
    await send({ type: 'CLEAR_ALL' });
    await load();
    setBusy(t('cleared'));
  };

  return (
    <div class="page">
      <div class="topline">
        <div class="brand">
          <img class="logo" src={chrome.runtime.getURL('src/ui/assets/icon128.png')} alt="" />
          <h1>{t('appName')}</h1>
        </div>
        <div class="lang-seg light" role="group">
          {LANGS.map((l) => (
            <button key={l.code} class={l.code === lang ? 'on' : ''} onClick={() => setLang(l.code)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <p class="sub">{t('tagline')}</p>

      <div class="card">
        <h2>{t('dashboard')}</h2>
        <div class="metrics">
          <div class="metric"><div class="v">{s.total}</div><div class="k">{t('mIndexed')}</div></div>
          <div class="metric"><div class="v">{s.pending}</div><div class="k">{t('mPending')}</div></div>
          <div class="metric"><div class="v">{metrics ? `${Math.round(metrics.ctr * 100)}%` : '—'}</div><div class="k">{t('mCTR')}</div></div>
          <div class="metric"><div class="v">{metrics ? metrics.mrr.toFixed(2) : '—'}</div><div class="k">{t('mMRR')}</div></div>
        </div>
        <p class="note" style="margin-top:14px">
          {t('effectiveN', { n: metrics?.effective ?? 0 })} · {t('openRate')}{' '}
          {metrics ? `${Math.round(metrics.openSuccess * 100)}%` : '—'}
        </p>
      </div>

      <div class="card">
        <h2>{t('semanticTitle')}</h2>
        <p class="desc">{t('semanticDesc')}</p>
        <p class="note" style="margin-top:12px">
          {t('statusLabel')}: <strong>{modelLabel(model)}</strong> · {t('backendLabel')}{' '}
          {model?.backend ?? '—'} · {model?.vectorCount ?? 0} {t('vectorized')}
        </p>
        {model?.state === 'DOWNLOADING' && (
          <span class="progress"><span class="bar" style={`width:${model.progress ?? 0}%`} /></span>
        )}
        {model?.state === 'ERROR' ? (
          <p class="note warn">{model.error}</p>
        ) : (
          model?.state !== 'READY' && <p class="note ok">↑ {t('semanticReadyNote')}</p>
        )}
      </div>

      <div class="card">
        <h2>{t('captureTitle')}</h2>
        <div class="row">
          <div>
            <div class="label">{t('pauseLabel')}</div>
            <div class="desc">{t('pauseDesc')}</div>
          </div>
          <label class="switch">
            <input type="checkbox" checked={s.paused} onChange={(e) => setPaused((e.target as HTMLInputElement).checked)} />
            <span class="slider" />
          </label>
        </div>
        <div class="row" style="display:block">
          <div class="label" style="margin-bottom:8px">{t('blacklistLabel')}</div>
          <textarea
            rows={4}
            value={blacklistText}
            onInput={(e) => setBlacklistText((e.target as HTMLTextAreaElement).value)}
            placeholder={'example-bank.com\nmail.company.com'}
          />
          <div class="actions"><button class="primary" onClick={saveBlacklist}>{t('saveBlocklist')}</button></div>
        </div>
      </div>

      <div class="card">
        <h2>{t('backupTitle')}</h2>
        <p class="note">{t('backupNote')}</p>
        <div class="actions">
          <button onClick={() => doExport(false)}>{t('exportBtn')}</button>
          <button onClick={() => doExport(true)}>{t('exportVecBtn')}</button>
          <label class="btn">
            {t('importBtn')}
            <input type="file" accept=".zip" style="display:none" onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void doImport(f);
            }} />
          </label>
        </div>
      </div>

      <div class="card">
        <h2>{t('storageTitle')}</h2>
        <p class="note">{t('persistOn')}</p>
        <p class="note">{t('plaintextNote')}</p>
        <div class="actions"><button class="danger" onClick={clearAll}>{t('clearAll')}</button></div>
      </div>

      {busy && <p class="note" style="text-align:center">{busy}</p>}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
