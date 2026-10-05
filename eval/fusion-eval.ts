// Offline evaluation + tuning of stage-2 search (source-language detection →
// translation variants → BM25 × vector → weighted RRF → record priors) over REAL
// captured data. Replays the production code (sourceLanguages, Bm25Index,
// fuseVariants, recordPrior, dedupe) against the browser-captured inputs from
// eval/fusion-dump.mjs, so a parameter sweep takes seconds.
//
// Usage:
//   npm run eval:fusion -- --backup ~/Downloads/spotrecall-backup-XXX.zip   # production config
//   npm run eval:fusion -- --backup … --verbose        # per-query ranks
//   npm run eval:fusion -- --backup … --ablation       # each improvement alone + stacked
//   npm run eval:fusion -- --backup … --grid           # parameter sweep
//   npm run eval:fusion -- --backup … --cv             # 2-fold tune/test split (overfit check)
//   npm run eval:fusion -- --backup … --rrf-k 5 --contentless-w 0.7   # overrides
//
// Options: --labels eval/labels-fusion.json  --dump eval/.cache/fusion-dump.json  --k 10
//          --bookmarked-backfill  (worst case: treat title-only records as bookmarks,
//          which get BOOKMARK_BOOST in the extension — the dump profile has none)
//
// Labels: [{ "query": "...", "match": ["url:<regex>", "title:<regex>"], "tag": "xling" }]
// A result is relevant if ANY pattern matches (bare patterns are URL regexes);
// `relevantUrls` (exact URLs, as in recall-eval) is also accepted. `tag` groups
// queries in the per-category table.

import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { Bm25Index, queryTerms } from '../src/search/bm25';
import {
  FUSION_PARAMS,
  type FusionParams,
  fuseVariants,
  recordPrior,
  dedupeByContent,
  snippetOf,
  displayKey,
} from '../src/search/fusion';
import {
  SOURCE_LANG_DEFAULTS,
  type SourceLangOptions,
  sourceLanguages,
  translationPlan,
  assembleVariants,
} from '../src/shared/query-lang';
import { isSearchableRecord } from '../src/shared/language';
import { normalizeUrl } from '../src/shared/url';
import { TRANSLATE_TARGETS } from '../src/shared/protocol';
import type { PageRecord } from '../src/shared/types';

const TOP_K = 50; // same cut as background/search.ts
const BOOKMARK_BOOST = 1.5; // same as background/search.ts

interface Label {
  query: string;
  match?: string[];
  relevantUrls?: string[];
  tag?: string;
}
type VecHits = { id: string; score: number }[] | null;
interface DumpQuery {
  query: string;
  detected: string | null;
  translations: Record<string, string>;
  vec: Record<string, VecHits>;
  liveVariants: string[];
  live: string[] | null;
}
interface Config {
  name: string;
  lang: Required<Omit<SourceLangOptions, 'detected'>>;
  fusion: FusionParams;
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function loadRecords(path: string): Promise<PageRecord[]> {
  const zip = unzipSync(await readFile(path));
  const f = zip['records.ndjson'];
  if (!f) throw new Error('backup has no records.ndjson');
  return strFromU8(f)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PageRecord);
}

function relevance(label: Label): (r: PageRecord) => boolean {
  const tests = (label.match ?? []).map((m) => {
    const [field, src] = m.startsWith('title:') ? ['title', m.slice(6)] : ['url', m.replace(/^url:/, '')];
    const re = new RegExp(src, 'i');
    return (r: PageRecord) => re.test(field === 'title' ? r.title : r.url);
  });
  const urls = new Set((label.relevantUrls ?? []).map(normalizeUrl));
  return (r) => tests.some((t) => t(r)) || urls.has(r.normalizedUrl || normalizeUrl(r.url));
}

async function main() {
  const backup = arg('backup');
  if (!backup) throw new Error('provide --backup <zip>');
  const labels = JSON.parse(await readFile(arg('labels', 'eval/labels-fusion.json')!, 'utf8')) as Label[];
  const dump = JSON.parse(await readFile(arg('dump', 'eval/.cache/fusion-dump.json')!, 'utf8')) as {
    createdAt: number;
    queries: DumpQuery[];
  };
  if (!dump.queries[0]?.translations) throw new Error('dump predates the all-directions format — re-run eval:fusion-dump');
  const K = parseInt(arg('k', '10')!, 10);
  const bookmarkedBackfill = flag('bookmarked-backfill');

  const records = (await loadRecords(backup)).filter(isSearchableRecord);
  const byId = new Map(records.map((r) => [r.id, r]));
  const bm25 = Bm25Index.fromRecords(records);
  const bm25Cache = new Map<string, string[]>();
  const bm25Of = (t: string) => bm25Cache.get(t) ?? bm25Cache.set(t, bm25.search(t, TOP_K).map((r) => r.id)).get(t)!;

  const dumpByQuery = new Map(dump.queries.map((q) => [q.query, q]));
  const cases = labels.flatMap((label) => {
    const d = dumpByQuery.get(label.query);
    if (!d) console.warn(`(skip) not in dump, re-run eval:fusion-dump: ${label.query}`);
    return d ? [{ label, d, tag: label.tag ?? '-', isRel: relevance(label) }] : [];
  });
  type Case = (typeof cases)[number];

  // Mirrors expandQuery(): detect source(s), translate per plan, assemble variants.
  const variantsFor = (c: Case, lang: Config['lang']) => {
    const sources = sourceLanguages(c.d.query, { ...lang, detected: c.d.detected ?? undefined });
    const plan = translationPlan(sources, TRANSLATE_TARGETS);
    return assembleVariants(c.d.query, plan.map(([s, t]) => c.d.translations[`${s}>${t}`]));
  };

  // Mirrors hitsFor() + decorateBookmarks(): priors, re-sort, dedupe.
  const finalize = (scored: { id: string; score: number }[], fusion: FusionParams, variants: string[]): PageRecord[] => {
    const variantTerms = variants.map(queryTerms);
    const items = scored.flatMap(({ id, score }) => {
      const r = byId.get(id);
      if (!r) return [];
      let s = score * recordPrior(r, variantTerms, fusion);
      if (bookmarkedBackfill && r.status === 'provisional') s *= BOOKMARK_BOOST;
      return [{ r, s }];
    });
    items.sort((a, b) => b.s - a.s);
    const recs = items.map((x) => x.r);
    return dedupeByContent(dedupeByContent(recs, (r) => r.contentHash), (r) => displayKey(r.title, snippetOf(r)));
  };

  const stage1 = (cfg: Config) => (c: Case) =>
    finalize(bm25Of(c.d.query).map((id, i) => ({ id, score: 1 / (i + 1) })), cfg.fusion, [c.d.query]);
  const stage2 = (cfg: Config) => (c: Case) => {
    const variants = variantsFor(c, cfg.lang);
    const fused = fuseVariants(
      variants.map(bm25Of),
      variants.map((v) => c.d.vec[v] ?? null),
      cfg.fusion,
    );
    return finalize(fused.slice(0, TOP_K), cfg.fusion, variants);
  };

  const rankOf = (rank: (c: Case) => PageRecord[], c: Case) => rank(c).findIndex(c.isRel) + 1;
  const metrics = (ranks: number[]) => {
    const n = ranks.length || 1;
    const mrr = ranks.reduce((s, p) => s + (p > 0 && p <= K ? 1 / p : 0), 0) / n;
    return {
      MRR: +mrr.toFixed(3),
      'Hit@1': ranks.filter((p) => p === 1).length,
      'Hit@3': ranks.filter((p) => p > 0 && p <= 3).length,
      [`Hit@${K}`]: ranks.filter((p) => p > 0 && p <= K).length,
      n: ranks.length,
    };
  };
  const evaluate = (rank: (c: Case) => PageRecord[], subset: Case[] = cases) =>
    metrics(subset.map((c) => rankOf(rank, c)));
  const tags = [...new Set(cases.map((c) => c.tag))];
  const byTag = (rank: (c: Case) => PageRecord[]) =>
    Object.fromEntries(tags.map((t) => [t, evaluate(rank, cases.filter((c) => c.tag === t)).MRR]));

  const num = (name: string, def: number) => (arg(name) !== undefined ? parseFloat(arg(name)!) : def);
  const prod: Config = {
    name: 'production',
    lang: { ...SOURCE_LANG_DEFAULTS },
    fusion: {
      bm25Weight: num('bm25-w', FUSION_PARAMS.bm25Weight),
      vecWeight: num('vec-w', FUSION_PARAMS.vecWeight),
      rrfK: num('rrf-k', FUSION_PARAMS.rrfK),
      translationWeight: num('trans-w', FUSION_PARAMS.translationWeight),
      vecMargin: num('margin', FUSION_PARAMS.vecMargin),
      vecDepth: num('depth', FUSION_PARAMS.vecDepth),
      contentlessWeight: num('contentless-w', FUSION_PARAMS.contentlessWeight),
    },
  };
  // Before Han hints / contentless prior: Han ⇒ zh, no priors.
  const neutral: Config = {
    name: 'baseline',
    lang: { hanHints: false, ambiguousHan: 'zh' },
    fusion: { ...prod.fusion, contentlessWeight: 1 },
  };

  console.log(
    `${records.length} searchable records, ${cases.length} labeled queries, K=${K}` +
      (bookmarkedBackfill ? ', title-only records boosted as bookmarks (worst case)' : ''),
  );

  const report = (cfgs: Config[]) =>
    console.table(
      cfgs.map((cfg) => ({ config: cfg.name, ...evaluate(stage2(cfg)), ...byTag(stage2(cfg)), s1: evaluate(stage1(cfg)).MRR })),
    );

  if (flag('ablation')) {
    const pick = (name: string, lang: Partial<Config['lang']>, fusion: Partial<FusionParams>): Config => ({
      name,
      lang: { ...neutral.lang, ...lang },
      fusion: { ...neutral.fusion, ...fusion },
    });
    const hints = { hanHints: true };
    const both = { hanHints: true, ambiguousHan: 'both' as const };
    const prior = { contentlessWeight: num('contentless-w', 0.5) };
    console.log('\nMRR per tag; s1 = stage-1 (BM25 only) MRR. Each row adds to the baseline:');
    report([
      neutral,
      pick('+ han hints', hints, {}),
      pick('+ han hints + both-direction fallback', both, {}),
      pick('+ ambiguous ⇒ ja (instead of both)', { hanHints: true, ambiguousHan: 'ja' }, {}),
      pick('+ contentless prior', {}, prior),
      pick('lang + contentless', both, prior),
      prod,
    ]);
    return;
  }

  const gridConfigs = (): Config[] => {
    const out: Config[] = [];
    for (const rrfK of [3, 5, 10])
      for (const translationWeight of [0.5, 0.7, 1])
        for (const vecWeight of [0.5, 1, 1.5])
          for (const contentlessWeight of [0.3, 0.5, 0.7, 1])
            out.push({
              name: `k=${rrfK} tw=${translationWeight} vw=${vecWeight} cl=${contentlessWeight}`,
              lang: prod.lang,
              fusion: { ...prod.fusion, rrfK, translationWeight, vecWeight, contentlessWeight },
            });
    return out;
  };

  if (flag('grid')) {
    const rows = gridConfigs().map((cfg) => ({ config: cfg.name, ...evaluate(stage2(cfg)), ...byTag(stage2(cfg)) }));
    rows.sort((a, b) => b.MRR - a.MRR || b['Hit@1'] - a['Hit@1']);
    console.table(rows.slice(0, 25));
    report([prod]);
    return;
  }

  if (flag('cv')) {
    // Tune on one half, score the other half: if grid-picked params don't beat
    // production on held-out queries, the extra tuning is fitting noise.
    const folds = [cases.filter((_, i) => i % 2 === 0), cases.filter((_, i) => i % 2 === 1)];
    const grid = gridConfigs();
    const rows = folds.map((train, f) => {
      const test = folds[1 - f];
      const best = grid.reduce((a, b) => (evaluate(stage2(b), train).MRR > evaluate(stage2(a), train).MRR ? b : a));
      return {
        fold: f,
        best: best.name,
        'train MRR (best)': evaluate(stage2(best), train).MRR,
        'test MRR (best)': evaluate(stage2(best), test).MRR,
        'test MRR (production)': evaluate(stage2(prod), test).MRR,
        'test MRR (baseline)': evaluate(stage2(neutral), test).MRR,
      };
    });
    console.table(rows);
    return;
  }

  if (flag('verbose')) {
    for (const c of cases) {
      const ranked = stage2(prod)(c);
      const pos = ranked.findIndex(c.isRel) + 1;
      const base = rankOf(stage2(neutral), c);
      const top = ranked.slice(0, 3).map((r) => r.title.slice(0, 26)).join(' / ');
      console.log(
        `${String(base || '-').padStart(3)} → ${String(pos || '-').padStart(3)}  [${c.tag}] ${c.d.query.padEnd(28)} ${top}`,
      );
      console.log(`        variants: ${JSON.stringify(variantsFor(c, prod.lang))}`);
    }
  }
  console.log('\nMRR per tag; s1 = stage-1 (BM25 only) MRR:');
  report([neutral, prod]);
  console.log(prod.fusion);
  if (cases.every((c) => c.d.live)) {
    console.log('\nParity: live stage-2 captured from the dumped build vs replay of its config.');
    console.log('(Only meaningful when the dump was made with the current build.)');
    const sameVariants = cases.filter((c) => JSON.stringify(variantsFor(c, prod.lang)) === JSON.stringify(c.d.liveVariants)).length;
    const live = (c: Case) => c.d.live!.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const sameTop = cases.filter(
      (c) => JSON.stringify(live(c).slice(0, K).map((r) => r.id)) === JSON.stringify(stage2(prod)(c).slice(0, K).map((r) => r.id)),
    ).length;
    console.table([{ ...evaluate(live), 'variants identical': `${sameVariants}/${cases.length}`, [`top-${K} identical`]: `${sameTop}/${cases.length}` }]);
    const mismatched = cases.filter((c) => live(c).slice(0, K).map((r) => r.id).join() !== stage2(prod)(c).slice(0, K).map((r) => r.id).join());
    for (const c of mismatched.slice(0, flag('verbose') ? mismatched.length : 3)) {
      const a = live(c).slice(0, K), b = stage2(prod)(c).slice(0, K);
      const at = a.findIndex((r, i) => r.id !== b[i]?.id);
      console.log(`  ${c.d.query}: first difference at #${at + 1}  live=${a[at]?.title.slice(0, 30)} | replay=${b[at]?.title.slice(0, 30)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
