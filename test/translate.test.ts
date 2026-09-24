import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadExpandQuery() {
  vi.resetModules();
  return (await import('../src/offscreen/translate')).expandQuery;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('expandQuery', () => {
  it('returns the original query when Chrome language APIs are unavailable', async () => {
    const expandQuery = await loadExpandQuery();

    await expect(expandQuery('find my router', ['en', 'ja', 'zh'])).resolves.toEqual(['find my router']);
  });

  it('does not translate when language detection has low confidence', async () => {
    const detect = vi.fn().mockResolvedValue([{ detectedLanguage: 'zh', confidence: 0.3 }]);
    vi.stubGlobal('LanguageDetector', { create: vi.fn().mockResolvedValue({ detect }) });

    const expandQuery = await loadExpandQuery();

    await expect(expandQuery('路由器设置', ['en'])).resolves.toEqual(['路由器设置']);
  });

  it('adds translations for target languages other than the source', async () => {
    const detect = vi.fn().mockResolvedValue([{ detectedLanguage: 'zh', confidence: 0.9 }]);
    const translate = vi.fn().mockResolvedValue('router setup');
    const availability = vi.fn().mockResolvedValue('available');
    vi.stubGlobal('LanguageDetector', { create: vi.fn().mockResolvedValue({ detect }) });
    vi.stubGlobal('Translator', {
      availability,
      create: vi.fn().mockResolvedValue({ translate }),
    });

    const expandQuery = await loadExpandQuery();

    await expect(expandQuery('路由器设置', ['zh', 'en'])).resolves.toEqual(['路由器设置', 'router setup']);
    expect(availability).toHaveBeenCalledWith({ sourceLanguage: 'zh', targetLanguage: 'en' });
    expect(translate).toHaveBeenCalledWith('路由器设置');
  });

  it('starts independent translations concurrently while preserving target order', async () => {
    const detect = vi.fn().mockResolvedValue([{ detectedLanguage: 'en', confidence: 0.9 }]);
    const started: string[] = [];
    const resolveTranslations = new Map<string, (value: string) => void>();
    vi.stubGlobal('LanguageDetector', { create: vi.fn().mockResolvedValue({ detect }) });
    vi.stubGlobal('Translator', {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn().mockImplementation(({ targetLanguage }) =>
        Promise.resolve({
          translate: () =>
            new Promise<string>((resolve) => {
              started.push(targetLanguage);
              resolveTranslations.set(targetLanguage, resolve);
            }),
        }),
      ),
    });

    const expandQuery = await loadExpandQuery();
    const result = expandQuery('router setup', ['ja', 'zh']);

    await vi.waitFor(() => expect(started).toEqual(['ja', 'zh']));
    resolveTranslations.get('zh')!('路由器设置');
    resolveTranslations.get('ja')!('ルーター設定');

    await expect(result).resolves.toEqual(['router setup', 'ルーター設定', '路由器设置']);
  });

  it('ignores unavailable translators and duplicate translations', async () => {
    const detect = vi.fn().mockResolvedValue([{ detectedLanguage: 'en', confidence: 0.9 }]);
    const availability = vi.fn().mockResolvedValueOnce('unavailable').mockResolvedValueOnce('available');
    vi.stubGlobal('LanguageDetector', { create: vi.fn().mockResolvedValue({ detect }) });
    vi.stubGlobal('Translator', {
      availability,
      create: vi.fn().mockResolvedValue({ translate: vi.fn().mockResolvedValue('find my router') }),
    });

    const expandQuery = await loadExpandQuery();

    await expect(expandQuery('find my router', ['ja', 'zh'])).resolves.toEqual(['find my router']);
  });

  it('warms a downloadable translator without blocking, then reuses it', async () => {
    const detect = vi.fn().mockResolvedValue([{ detectedLanguage: 'en', confidence: 0.9 }]);
    const translate = vi.fn().mockResolvedValue('ルーター設定');
    const create = vi.fn().mockResolvedValue({ translate });
    const availability = vi.fn().mockResolvedValue('downloadable');
    vi.stubGlobal('LanguageDetector', { create: vi.fn().mockResolvedValue({ detect }) });
    vi.stubGlobal('Translator', { availability, create });

    const expandQuery = await loadExpandQuery();

    await expect(expandQuery('router setup', ['ja'])).resolves.toEqual(['router setup']);
    await expect(expandQuery('router setup', ['ja'])).resolves.toEqual(['router setup', 'ルーター設定']);
    expect(create).toHaveBeenCalledTimes(1);
    expect(availability).toHaveBeenCalledTimes(1);
  });
});