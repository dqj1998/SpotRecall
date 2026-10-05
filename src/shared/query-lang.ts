// Query source-language detection for cross-lingual expansion. Pure & shared with
// eval/fusion-eval.ts so detection strategies can be compared offline.

import { ZH_ONLY_HAN, JA_ONLY_HAN } from './han-tables';

const ZH_ONLY = new Set(ZH_ONLY_HAN);
const JA_ONLY = new Set(JA_ONLY_HAN);

export interface SourceLangOptions {
  /** Confident LanguageDetector result, when that model is available. */
  detected?: string;
  /** Use charset-derived zh-only / ja-only characters to split Han-only text. */
  hanHints?: boolean;
  /** Han text with no distinguishing characters (名片管理, 会社概要): treat it as
   *  zh, ja, or both — translating from each, since a wrong guess yields garbage. */
  ambiguousHan?: 'zh' | 'ja' | 'both';
}

export const SOURCE_LANG_DEFAULTS: Required<Omit<SourceLangOptions, 'detected'>> = {
  hanHints: true,
  ambiguousHan: 'both',
};

/** Count characters that only Simplified Chinese / only Japanese use. */
export function hanHints(text: string): { zh: number; ja: number } {
  let zh = 0;
  let ja = 0;
  for (const ch of text) {
    if (ZH_ONLY.has(ch)) zh++;
    else if (JA_ONLY.has(ch)) ja++;
  }
  return { zh, ja };
}

/**
 * Likely source language(s) of a query. Kana ⇒ ja and Hangul ⇒ ko outright.
 * Han-only text is split by distinguishing characters (帯/図 ⇒ ja, 们/门 ⇒ zh),
 * then by the detector, then `ambiguousHan`. Latin falls back to en.
 */
export function sourceLanguages(text: string, opts: SourceLangOptions = {}): string[] {
  const { detected, hanHints: useHints, ambiguousHan } = { ...SOURCE_LANG_DEFAULTS, ...opts };
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return ['ja'];
  if (/\p{Script=Hangul}/u.test(text)) return ['ko'];
  if (/\p{Script=Han}/u.test(text)) {
    if (useHints) {
      const { zh, ja } = hanHints(text);
      if (zh > ja) return ['zh'];
      if (ja > zh) return ['ja'];
    }
    if (detected === 'zh' || detected === 'ja') return [detected];
    return ambiguousHan === 'both' ? ['zh', 'ja'] : [ambiguousHan];
  }
  if (detected) return [detected];
  if (/\p{Script=Latin}/u.test(text)) return ['en'];
  return [];
}

/** Translation directions for the given sources: every target except the source itself. */
export function translationPlan(sources: string[], targets: string[]): [string, string][] {
  const plan: [string, string][] = [];
  for (const src of sources) {
    for (const tgt of new Set(targets)) if (tgt !== src) plan.push([src, tgt]);
  }
  return plan;
}

/** Original query first, then distinct non-empty translations. */
export function assembleVariants(text: string, translations: (string | undefined)[]): string[] {
  const variants = [text];
  for (const t of translations) if (t && t.trim() && t !== text) variants.push(t);
  return [...new Set(variants)];
}
