import { describe, expect, test } from 'bun:test';
import { splitBubbles } from '../src/lib/message-display';

describe('IM display transforms', () => {
  test('splits custom separators and hides them without changing the stored input', () => {
    const raw = '你好|||今天过得怎么样？|||';
    expect(splitBubbles(raw, '|||')).toEqual(['你好', '今天过得怎么样？']);
    expect(raw).toBe('你好|||今天过得怎么样？|||');
  });
  test('supports newline separators, disabled splitting, and suppresses empty bubbles', () => {
    expect(splitBubbles('第一句\n\n第二句', '\n\n')).toEqual(['第一句', '第二句']);
    expect(splitBubbles('第一句|||第二句', '')).toEqual(['第一句|||第二句']);
    expect(splitBubbles('||| ||||||', '|||')).toEqual([]);
  });
  test('holds partial separators during streaming, but preserves ordinary characters after completion', () => {
    expect(splitBubbles('你好||', '|||', [], true)).toEqual(['你好']);
    expect(splitBubbles('你好|||下次见|', '|||', [], true)).toEqual(['你好', '下次见']);
    expect(splitBubbles('你好||', '|||', [], false)).toEqual(['你好||']);
  });
  test('hides exact literal symbols rather than evaluating regex or markup', () => {
    expect(
      splitBubbles('[aside]你好.*|||<tag>朋友</tag>', '|||', ['[aside]', '.*', '<tag>', '</tag>']),
    ).toEqual(['你好', '朋友']);
    expect(splitBubbles('<script>alert(1)</script>', '', [])).toEqual([
      '<script>alert(1)</script>',
    ]);
  });
  test('does not flash incomplete hidden markers and prefers longest matches', () => {
    expect(splitBubbles('你好<con', '', ['<control>'], true)).toEqual(['你好']);
    expect(splitBubbles('你好<control>', '', ['<control>'], true)).toEqual(['你好']);
    expect(splitBubbles('你好<con', '', ['<control>'], false)).toEqual(['你好<con']);
    expect(splitBubbles('a**b*c', '', ['*', '**'])).toEqual(['abc']);
  });
  test('splits before masking and caps bubble nodes without discarding text', () => {
    expect(splitBubbles('甲|||乙', '|||', ['|'])).toEqual(['甲', '乙']);
    const result = splitBubbles(
      Array.from({ length: 100 }, (_, n) => String(n)).join('|||'),
      '|||',
    );
    expect(result).toHaveLength(64);
    expect(result.at(-1)).toContain('99');
  });
});
