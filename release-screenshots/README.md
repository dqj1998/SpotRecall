# Release screenshots and promo art

Everything here is generated. Never hand-edit a PNG — change
[`scripts/make-screenshots.mjs`](../scripts/make-screenshots.mjs) and rerun:

```bash
npm run make-screenshots
```

The script renders the real palette UI with its actual CSS (`src/ui/tokens.css`,
`src/ui/palette-layout.css`) in headless Chrome, so the art cannot drift from the
shipped interface.

## Layout

```
release-screenshots/
├── screenshot-1..5.png              1280x800   all-languages screenshots (English)
├── promo-marquee-1400x560.png       1400x560   marquee promo tile (English)
├── promo-small-440x280.png           440x280   small promo tile (English)
└── localized/<locale>/
    ├── screenshot-1.png             1280x800   language-matched first screenshot
    ├── promo-marquee-1400x560.png   1400x560   language-matched marquee tile
    └── promo-small-440x280.png       440x280   language-matched small tile
```

`<locale>` covers the same 21 locales as `public/_locales/`: `ar de en es fr hi
id it ja ko nl pl pt_BR pt_PT ru th tr uk vi zh_CN zh_TW`. The two sets are kept
in lockstep — the generator throws if one has a locale the other lacks.

## The two stores disagree about localized promo tiles

This is the single most important thing to know before uploading, and the two
stores behave in opposite ways.

| Asset | Chrome Web Store | Edge Add-ons |
|---|---|---|
| Screenshots | per-locale (max 5) | per-language (max 6) |
| Small promo tile 440x280 | **all languages only** | **one per language**, optional |
| Marquee / large tile 1400x560 | **all languages only** | **one per language**, optional |
| Logo | 128x128, all languages | 300x300, one per language, required |

### Chrome Web Store — tiles are NOT localizable

The listing editor exposes five file inputs. The two promo-tile inputs sit in
neither the localized-assets block nor the all-languages block, and selecting a
different locale does not add per-locale tile inputs. Verified in the dashboard
DOM on a non-default locale, not inferred from documentation.

So on Chrome:

- Upload `promo-marquee-1400x560.png` and `promo-small-440x280.png` **once**.
  One pair serves all 21 locales.
- Upload `localized/<locale>/screenshot-1.png` per locale — screenshots *are*
  localizable, and each locale must end up with exactly one.
- The `localized/<locale>/promo-*.png` files have **no slot on Chrome**. They are
  not dead weight; see below.

### Edge Add-ons — tiles ARE localizable

Microsoft documents both tiles as "one per language", both optional, so every
file under `localized/<locale>/` has a home on Edge. Partner Center derives its
store-listing languages from the `_locales` folder inside the uploaded package,
which is why the locale sets are kept identical.

Two hazards when uploading to Edge:

- Partner Center offers a **Duplicate** control that copies one asset to every
  language. That is correct for the 300x300 logo and **wrong for the tiles** — it
  would overwrite all the localized work with a single language's art.
- Edge accepts 6 screenshots per language where Chrome accepts 5. Do not let the
  extra slot pull in a duplicate of `screenshot-1`.

## Why the localized art is worth the trouble

The per-locale renders are not translations bolted onto English layout. The
generator handles two things that fixed-size English-first art gets wrong:

- **Autofit.** Translations run much longer than the English original. Each line
  authored with `<br/>` becomes its own nowrap block and shrinks until it fits,
  so an intended two-line headline never silently spills onto a third line.
- **RTL.** Arabic mirrors the whole marketing layout, including the brand
  gradient, so the copy keeps the blue end of the gradient behind it. The product
  card stays LTR because its mock result rows are Latin text. Without this,
  sentence-final punctuation lands at the start of the wrapped line.

## Procedure

The step-by-step release sequence, including the dashboard quirks worth knowing
before automating anything, lives in the private Etc repo at
`SpotRecallEtc/plans/store-release-workflow.md`. Store-listing copy for each
locale is in [`store-listings/`](../store-listings/).
