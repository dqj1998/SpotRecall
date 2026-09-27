# Chrome Web Store Localized Listings

Each locale file contains the name, short description, latest What's New text,
and detailed description to paste into the matching Chrome Web Store dashboard
listing. The locale code matches the directory under `public/_locales/`.

Per-release What's New copy for all locales is collected in
`whats-new-<version>.md` files (e.g. `whats-new-1.2.0.md`).

Supported release locales: `ar`, `de`, `en`, `es`, `fr`, `hi`, `id`, `it`, `ja`,
`ko`, `nl`, `pl`, `pt_BR`, `pt_PT`, `ru`, `th`, `tr`, `uk`, `vi`, `zh_CN`, and
`zh_TW`.

The Chrome Web Store dashboard listing must be localized separately from the
extension manifest. Updating `public/_locales/` localizes only the extension
name and short description shown by Chrome.