import type { PageRecord } from './types';

export interface LanguageDistribution {
  counts: Record<string, number>;
  recordsCounted: number;
}

export interface LanguageCandidateOptions {
  browserLocale?: string;
  fallbackLanguages: string[];
  coldStartRecordThreshold: number;
  maxCandidates: number;
}

/** Normalize a declared BCP-47 tag for translation target selection. */
export function normalizeLanguageTag(tag: string | undefined): string | undefined {
  if (!tag?.trim()) return undefined;
  try {
    const locale = new Intl.Locale(tag);
    const language = locale.language.toLowerCase();
    if (language === 'und') return undefined;
    if (language === 'zh' && locale.maximize().script?.toLowerCase() === 'hant') return 'zh-Hant';
    return language;
  } catch {
    return undefined;
  }
}

/** Matches the record eligibility used when rebuilding the BM25 index. */
export function isSearchableRecord(record: PageRecord): boolean {
  return record.status === 'committed' || Boolean(record.cleanText) || Boolean(record.title);
}

/** Recompute a language distribution from the records source of truth. */
export function countRecordLanguages(records: PageRecord[]): LanguageDistribution {
  const counts: Record<string, number> = {};
  let recordsCounted = 0;
  for (const record of records) {
    if (!isSearchableRecord(record)) continue;
    const language = normalizeLanguageTag(record.language);
    if (!language) continue;
    counts[language] = (counts[language] ?? 0) + 1;
    recordsCounted++;
  }
  return { counts, recordsCounted };
}

/**
 * Order translation target candidates. The caller must not trim this list to
 * successful translations: that requires source-language and Translator
 * availability information only the offscreen document has.
 */
export function selectLanguageCandidates(
  distribution: LanguageDistribution,
  options: LanguageCandidateOptions,
): string[] {
  const corpusLanguages = Object.entries(distribution.counts)
    .filter(([, count]) => count > 0)
    .sort(([leftLanguage, leftCount], [rightLanguage, rightCount]) =>
      rightCount === leftCount ? leftLanguage.localeCompare(rightLanguage) : rightCount - leftCount,
    )
    .map(([language]) => language);

  const candidates = [...corpusLanguages];
  if (distribution.recordsCounted < options.coldStartRecordThreshold) {
    const locale = normalizeLanguageTag(options.browserLocale);
    if (locale) candidates.push(locale);
    candidates.push(...options.fallbackLanguages.map(normalizeLanguageTag).filter((x): x is string => Boolean(x)));
  }

  return [...new Set(candidates)].slice(0, options.maxCandidates);
}