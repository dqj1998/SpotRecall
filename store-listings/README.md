# Chrome Web Store Localized Listings

Each locale file contains the name, short description, and detailed description
to paste into the matching Chrome Web Store dashboard listing. The locale code
matches the directory under `public/_locales/`.

**What's New lives only in `whats-new-<version>.md`** (e.g. `whats-new-1.2.1.md`),
one file per release covering all 21 locales. The locale files above deliberately
do not repeat it — release notes change every release and the listing copy does
not, so keeping them apart means nothing goes stale.

Neither the Chrome Web Store nor Edge Add-ons has a public release-notes field.
On both stores the What's New text is appended as the **last paragraph of each locale's
description**, replacing the previous release's paragraph so descriptions do not
accumulate old notes.

Each locale file ends with a short ContextWizard cross-promo paragraph (store link
tagged `utm_source=spotrecall&utm_medium=cws_listing`). Paste it with the rest of the
description; the What's New paragraph goes after it.

Supported release locales: `ar`, `de`, `en`, `es`, `fr`, `hi`, `id`, `it`, `ja`,
`ko`, `nl`, `pl`, `pt_BR`, `pt_PT`, `ru`, `th`, `tr`, `uk`, `vi`, `zh_CN`, and
`zh_TW`.

The Chrome Web Store dashboard listing must be localized separately from the
extension manifest. Updating `public/_locales/` localizes only the extension
name and short description shown by Chrome.