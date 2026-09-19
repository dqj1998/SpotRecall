import { useState, useEffect, useCallback } from 'preact/hooks';
import { detectLang, translate, type Lang } from '@shared/i18n';

const KEY = 'sr_lang';

/** Language state persisted to chrome.storage.local, synced across popup/panel. */
export function useI18n() {
  const [lang, setLangState] = useState<Lang>(detectLang());

  useEffect(() => {
    chrome.storage.local.get(KEY).then((r) => {
      setLangState(((r[KEY] as Lang) || detectLang()));
    });
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === 'local' && changes[KEY]) {
        setLangState((changes[KEY].newValue as Lang) || detectLang());
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    void chrome.storage.local.set({ [KEY]: l });
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(lang, key, params),
    [lang],
  );

  return { lang, setLang, t };
}
