import { describe, expect, test } from 'bun:test';
import { hasAmbiguousCharacterNames, mentionedCharacterIds } from '../src/lib/server/mentions';

const cast = [
  { id: 'moon', name: '月' },
  { id: 'moonlight', name: '月光' },
  { id: 'star', name: 'Star Light' },
  { id: 'literal', name: 'A+B (test)' },
];

describe('group character mention addressing', () => {
  test('requires explicit mentions and preserves appearance order', () => {
    expect(mentionedCharacterIds('月光在这里。', cast)).toEqual([]);
    expect(mentionedCharacterIds('@月光 你好。@月，你先说。 @Star Light!', cast)).toEqual([
      'moonlight',
      'moon',
      'star',
    ]);
  });
  test('does not mistake prefixes or email addresses for mentions', () => {
    expect(mentionedCharacterIds('@月光石 name@月光.com @月光你好', cast)).toEqual([]);
    expect(mentionedCharacterIds('@月光，晚上好。', cast)).toEqual(['moonlight']);
  });
  test('escapes names, matches case-insensitively and deduplicates', () => {
    expect(mentionedCharacterIds('@A+B (test) 你好。 @star light @STAR LIGHT', cast)).toEqual([
      'literal',
      'star',
    ]);
  });
  test('detects names ambiguous after normalization', () => {
    expect(hasAmbiguousCharacterNames([{ name: 'Luna' }, { name: 'luna' }])).toBe(true);
    expect(hasAmbiguousCharacterNames([{ name: 'Ａ' }, { name: 'A' }])).toBe(true);
    expect(hasAmbiguousCharacterNames(cast)).toBe(false);
  });
});
