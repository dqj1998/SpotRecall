import { describe, it, expect } from 'vitest';
import { checkModelConfigJson } from '@shared/model-file';

describe('checkModelConfigJson — corrupt-bundle detection (0%-download fix)', () => {
  it('rejects empty text (the 0-byte config.json from a broken download)', () => {
    expect(checkModelConfigJson('')).toEqual({ ok: false, reason: 'config.json is empty' });
    expect(checkModelConfigJson('   \n ').ok).toBe(false);
  });

  it('rejects syntactically invalid JSON', () => {
    const r = checkModelConfigJson('{');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not valid JSON/);
    expect(checkModelConfigJson('{"model_type":').ok).toBe(false);
  });

  it('rejects a JSON value that is not an object', () => {
    expect(checkModelConfigJson('[]').ok).toBe(false);
    expect(checkModelConfigJson('42').ok).toBe(false);
    expect(checkModelConfigJson('"str"').ok).toBe(false);
  });

  it('rejects an object missing model_type (e.g. a proxy answering {})', () => {
    expect(checkModelConfigJson('{}').ok).toBe(false);
    expect(checkModelConfigJson('{"architectures": ["XxxModel"]}').ok).toBe(false);
  });

  it('rejects an object missing architectures', () => {
    const r = checkModelConfigJson('{"model_type": "xlm-roberta"}');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/architectures/);
  });

  it('accepts a realistic multilingual-e5 config', () => {
    const text = JSON.stringify({
      model_type: 'xlm-roberta',
      architectures: ['XLMRobertaModel'],
      hidden_size: 384,
    });
    expect(checkModelConfigJson(text)).toEqual({ ok: true });
  });
});