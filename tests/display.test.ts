import { describe, expect, test } from 'bun:test';
import { messageBubbles, stripDisplaySymbols, visibleMessage } from '../src/lib/display';

describe('literal message bubble presentation', () => {
  test('splits before stripping overlapping symbols and omits empty bubbles', () => {
    const raw = '|||*你好*|||第二条。||||||';
    expect(messageBubbles(raw, { bubbleDelimiter: '|||', hiddenSymbols: ['*', '|'] })).toEqual([
      '你好',
      '第二条。',
    ]);
    expect(raw).toBe('|||*你好*|||第二条。||||||');
  });
  test('does not evaluate regex syntax, preserves text and Unicode without configuration', () => {
    expect(messageBubbles('你好 🌙\n下一行')).toEqual(['你好 🌙\n下一行']);
    expect(messageBubbles('one.*two', { bubbleDelimiter: '.*' })).toEqual(['one', 'two']);
    expect(stripDisplaySymbols('🎈A[hide]B🎈', { hiddenSymbols: ['🎈', '[hide]'] })).toBe('AB');
  });
  test('prefers longest matching hidden symbol and never enters an empty-pattern loop', () => {
    expect(stripDisplaySymbols('**hello** *world*', { hiddenSymbols: ['', '**', '*'] })).toBe(
      'hello world',
    );
    expect(stripDisplaySymbols('aXb', { hiddenSymbols: ['X', 'ab'] })).toBe('ab');
  });
  test('single user messages stay one bubble; copies and previews use visible text', () => {
    const settings = { bubbleDelimiter: '|', hiddenSymbols: ['*'] };
    expect(messageBubbles('*hello*|world', settings, false)).toEqual(['hello|world']);
    expect(visibleMessage('*hello*|world', settings)).toBe('hello\n\nworld');
    expect(messageBubbles('***', settings)).toEqual([]);
  });
});
