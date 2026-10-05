import { describe, it, expect } from 'vitest';
import { sourceLanguages, hanHints, translationPlan, assembleVariants } from '@shared/query-lang';

describe('sourceLanguages', () => {
  it('kana ⇒ ja, hangul ⇒ ko, latin ⇒ en', () => {
    expect(sourceLanguages('表札の通販')).toEqual(['ja']);
    expect(sourceLanguages('문패')).toEqual(['ko']);
    expect(sourceLanguages('exercise bike')).toEqual(['en']);
    expect(sourceLanguages('12345')).toEqual([]);
  });

  it('splits Han-only text by charset-specific characters', () => {
    expect(sourceLanguages('表札 二世帯')).toEqual(['ja']); // 帯 (zh: 带)
    expect(sourceLanguages('飯能市 地図')).toEqual(['ja']); // 飯 図
    expect(sourceLanguages('门牌 网购')).toEqual(['zh']); // 门 购
    expect(sourceLanguages('Gardening的日语翻译')).toEqual(['zh']); // 语 译
  });

  it('ambiguous Han text uses the detector, else translates from both', () => {
    expect(sourceLanguages('名片管理')).toEqual(['zh', 'ja']);
    expect(sourceLanguages('名片管理', { detected: 'zh' })).toEqual(['zh']);
    expect(sourceLanguages('名片管理', { ambiguousHan: 'zh' })).toEqual(['zh']);
  });

  it('character hints outrank the detector for Han text', () => {
    expect(sourceLanguages('表札 二世帯', { detected: 'zh' })).toEqual(['ja']);
  });

  it('without hints, Han follows the detector or the ambiguous policy', () => {
    expect(sourceLanguages('表札 二世帯', { hanHints: false, ambiguousHan: 'zh' })).toEqual(['zh']);
  });
});

describe('hanHints', () => {
  it('ignores characters shared by both languages', () => {
    expect(hanHints('日本中国')).toEqual({ zh: 0, ja: 0 });
    expect(hanHints('们帯')).toEqual({ zh: 1, ja: 1 });
  });
});

describe('translationPlan / assembleVariants', () => {
  it('plans every target except the source, per source', () => {
    expect(translationPlan(['zh', 'ja'], ['en', 'ja', 'zh'])).toEqual([
      ['zh', 'en'], ['zh', 'ja'], ['ja', 'en'], ['ja', 'zh'],
    ]);
  });

  it('keeps the original first and drops empty / duplicate translations', () => {
    expect(assembleVariants('q', ['a', undefined, ' ', 'q', 'a', 'b'])).toEqual(['q', 'a', 'b']);
  });
});
