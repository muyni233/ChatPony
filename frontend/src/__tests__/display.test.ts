import { describe, expect, it } from 'vitest';
import {
  initialsOf,
  messageBubbles,
  parseActionSegments,
  stripDisplaySymbols,
} from '../lib/display';
import {
  clearConversationCache,
  getCachedConversation,
  setCachedConversation,
} from '../lib/conversationCache';
import type { ConversationDetail } from '../lib/types';

describe('display helpers', () => {
  it('strips configured hidden symbols and splits bubbles', () => {
    expect(stripDisplaySymbols('Hello~~ World~~', ['~~'])).toBe('Hello World');
    expect(messageBubbles('Hi|||There|||', '|||')).toEqual(['Hi', 'There']);
    expect(messageBubbles('Hi|||There', '|||', [], false)).toEqual(['Hi|||There']);
  });

  it('parses action narration markers with optional marker hiding', () => {
    const shown = parseActionSegments('她*轻轻点头*说道：（欢迎回来）', true, ['*', '（）'], false);
    expect(shown).toEqual([
      { text: '她', action: false },
      { text: '*轻轻点头*', action: true },
      { text: '说道：', action: false },
      { text: '（欢迎回来）', action: true },
    ]);

    const hidden = parseActionSegments('*微笑*', true, ['*'], true);
    expect(hidden).toEqual([{ text: '微笑', action: true }]);
  });

  it('continues matching markers after unclosed multiline or empty pairs', () => {
    const multiline = parseActionSegments('*未闭合\n她*轻轻点头*', true, ['*'], false);
    expect(multiline).toEqual([
      { text: '*未闭合\n她', action: false },
      { text: '*轻轻点头*', action: true },
    ]);

    const afterEmpty = parseActionSegments('**标题** 然后*微笑*', true, ['*'], false);
    expect(afterEmpty).toEqual([
      { text: '**标题** 然后', action: false },
      { text: '*微笑*', action: true },
    ]);
  });

  it('formats character initials cleanly including unicode surrogate pairs', () => {
    expect(initialsOf('Twilight Sparkle')).toBe('TS');
    expect(initialsOf('暮光闪闪')).toBe('暮光');
    expect(initialsOf('🦄 Star')).toBe('🦄S');
  });
});

describe('conversation LRU cache', () => {
  it('caches and evicts oldest item past 12 entries', () => {
    clearConversationCache();
    const makeDetail = (id: string): ConversationDetail => ({
      conversation: {
        id,
        userId: 'u1',
        title: `Conv ${id}`,
        kind: 'private',
        characterIds: ['c1'],
        summary: '',
        maxRounds: 4,
        createdAt: '',
        updatedAt: '',
        lastMessage: '',
      },
      characters: [],
      messages: [],
    });

    for (let i = 1; i <= 13; i++) {
      setCachedConversation(`c-${i}`, makeDetail(`c-${i}`));
    }
    expect(getCachedConversation('c-1')).toBeUndefined();
    expect(getCachedConversation('c-13')?.conversation.title).toBe('Conv c-13');
  });
});
