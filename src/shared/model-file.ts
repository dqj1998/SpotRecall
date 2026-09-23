// Shared, framework-free validation for the locally bundled embedding model.
//
// Why: a broken `npm run download-model` (e.g. an intercepted HTTP 200 with an
// empty body) leaves 0-byte files in the bundle. Transformers.js trusts any
// local fetch that returns HTTP 200, so a corrupt bundle aborts loading with a
// cryptic "SyntaxError: Unexpected end of JSON input" instead of falling back
// to the one-time remote download — and the panel's download progress stays at
// 0%. `checkModelConfigJson` lets both the build script (scripts/download-model.mjs)
// and the offscreen embedder detect that state.

export interface ConfigCheck {
  ok: boolean;
  reason?: string;
}

/** Validate the embedding model's config.json text: non-empty, valid JSON, and
 *  carrying the keys transformers.js needs to build its pipeline. */
export function checkModelConfigJson(text: string): ConfigCheck {
  if (!text || text.trim().length === 0) {
    return { ok: false, reason: 'config.json is empty' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      reason: `config.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'config.json is not a JSON object' };
  }
  const cfg = parsed as Record<string, unknown>;
  if (typeof cfg.model_type !== 'string' || cfg.model_type.length === 0) {
    return { ok: false, reason: 'config.json is missing "model_type"' };
  }
  if (!Array.isArray(cfg.architectures) || cfg.architectures.length === 0) {
    return { ok: false, reason: 'config.json is missing "architectures"' };
  }
  return { ok: true };
}