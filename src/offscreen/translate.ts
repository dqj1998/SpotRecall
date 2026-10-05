// Cross-lingual query expansion via Chrome's on-device Translation API.
// Turns a cross-lingual search into a same-language one — far more effective than
// relying on the embedding model's cross-lingual alignment (see eval). Fully
// feature-detected; silently returns just the original query when unavailable.

import { sourceLanguages, translationPlan, assembleVariants } from '@shared/query-lang';

const hasTranslator = typeof Translator !== 'undefined';
const hasDetector = typeof LanguageDetector !== 'undefined';

let detectorPromise: Promise<SRLanguageDetector> | null = null;
const translators = new Map<string, Promise<SRTranslator>>();

/** Confident LanguageDetector result; undefined when that model is unavailable
 *  (it is a separate on-device download, often missing even when Translator works). */
async function detectLang(text: string): Promise<string | undefined> {
  if (!hasDetector || !LanguageDetector) return undefined;
  try {
    detectorPromise ??= LanguageDetector.create();
    const results = await (await detectorPromise).detect(text);
    const top = results[0];
    return top && top.confidence > 0.3 ? top.detectedLanguage : undefined;
  } catch {
    detectorPromise = null; // model unavailable — retry next time
    return undefined;
  }
}

async function translate(text: string, source: string, target: string): Promise<string | undefined> {
  if (!hasTranslator || !Translator || source === target) return undefined;
  const key = `${source}->${target}`;
  try {
    if (translators.has(key)) {
      return await (await translators.get(key)!).translate(text);
    }
    const avail = await Translator.availability({ sourceLanguage: source, targetLanguage: target });
    if (avail === 'unavailable') return undefined;
    // Cache the (possibly downloading) instance for reuse.
    translators.set(key, Translator.create({ sourceLanguage: source, targetLanguage: target }));
    if (avail === 'available') {
      return await (await translators.get(key)!).translate(text);
    }
    // 'downloadable' / 'downloading': warm it up for next time, don't block now.
    return undefined;
  } catch {
    translators.delete(key);
    return undefined;
  }
}

/**
 * Return the original query plus translations into `targets` (the UI languages),
 * deduped. Cross-lingual queries thus also match same-language docs via BM25 and
 * a same-language vector comparison. Ambiguous Han-only queries are translated
 * from both zh and ja (see sourceLanguages). Best-effort: falls back to [text].
 */
export async function expandQuery(text: string, targets: string[]): Promise<string[]> {
  const sources = sourceLanguages(text, { detected: await detectLang(text) });
  const plan = translationPlan(sources, targets);
  const translations = await Promise.all(plan.map(([src, tgt]) => translate(text, src, tgt)));
  return assembleVariants(text, translations);
}
