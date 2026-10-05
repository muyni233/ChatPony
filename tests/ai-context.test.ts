import { describe, expect, test } from 'bun:test';
import { estimateTokens, truncateToTokenBudget, prepareContextWith } from '../src/lib/ai/context';
import { createAIClient } from '../src/lib/ai';
import type { ContextInput, ContextMessage, GenerateInput, ProviderConfig } from '../src/lib/ai';

const config: ProviderConfig = {
  protocol: 'openai-chat',
  baseUrl: 'https://api.example.com/v1',
  model: 'test',
  apiKey: 'test',
  contextWindow: 4096,
  maxOutputTokens: 512,
  temperature: 0.8,
};
const history = (count: number, length: number): ContextMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `第${i}条：${'故事'.repeat(length)}`,
  }));

describe('context and durable summary boundaries', () => {
  test('estimates multilingual text conservatively and never clips through an emoji', () => {
    expect(estimateTokens('hello world!')).toBe(4);
    expect(estimateTokens('你好')).toBe(4);
    expect(estimateTokens('🦄')).toBe(3);
    const clipped = truncateToTokenBudget('你好🦄你好🦄', 10);
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(10);
    expect(clipped).not.toMatch(/[\ud800-\udbff]$/);
  });

  test('keeps fitting histories unchanged without spending a summary call', async () => {
    let calls = 0;
    const messages = history(4, 20);
    const result = await prepareContextWith(
      config,
      { system: '你是暮光闪闪。', messages },
      async () => {
        calls++;
        return '';
      },
    );
    expect(calls).toBe(0);
    expect(result.compressed).toBe(false);
    expect(result.messages).toEqual(messages.map(({ role, content }) => ({ role, content })));
    expect(result.estimatedTokens).toBeLessThanOrEqual(config.contextWindow);
  });

  test('summarizes older messages but preserves the requested recent window verbatim', async () => {
    const messages = history(20, 70);
    const calls: GenerateInput[] = [];
    const result = await prepareContextWith(
      config,
      { system: '角色设定', messages, keepRecentMessages: 4, memory: '我叫星星。' },
      async (_config, input) => {
        calls.push(input);
        return '用户叫星星，和暮光闪闪一起在图书馆研究一本古籍。';
      },
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(result.compressed).toBe(true);
    expect(result.summaryMessageId).toBe('m15');
    expect(result.messages).toEqual(
      messages.slice(-4).map(({ role, content }) => ({ role, content })),
    );
    expect(result.system).toContain('我叫星星。');
    expect(result.system).toContain('用户叫星星');
    expect(result.estimatedTokens).toBeLessThanOrEqual(config.contextWindow);
    expect(calls.map((call) => call.messages[0].content).join('')).not.toContain('第19条');
  });

  test('excludes only messages covered by the persisted marker', async () => {
    const messages = history(8, 25);
    const result = await prepareContextWith(
      config,
      { system: '角色', messages, summary: '已有摘要', summaryMessageId: 'm3' },
      async () => {
        throw new Error('unexpected summary call');
      },
    );
    expect(result.messages).toEqual(
      messages.slice(4).map(({ role, content }) => ({ role, content })),
    );
    expect(result.summaryMessageId).toBe('m3');
    expect(result.system).toContain('已有摘要');
    const stale = await prepareContextWith(
      config,
      { system: '角色', messages, summary: '错误旧摘要', summaryMessageId: 'missing' },
      async () => '',
    );
    expect(stale.messages).toHaveLength(8);
    expect(stale.summaryMessageId).toBeNull();
    expect(stale.system).not.toContain('错误旧摘要');
  });

  test('clips oversized optional memories while retaining the latest user message', async () => {
    const result = await prepareContextWith(
      config,
      {
        system: '角色',
        messages: [{ id: 'u1', role: 'user', content: '你好' }],
        memory: '长期记忆'.repeat(2000),
      },
      async () => {
        throw new Error('unexpected summary call');
      },
    );
    expect(result.messages[0].content).toBe('你好');
    expect(result.system.length).toBeLessThan(1500);
    expect(result.estimatedTokens).toBeLessThanOrEqual(config.contextWindow);
  });

  test('rejects huge recent prompts rather than silently losing the request', async () => {
    const client = createAIClient();
    await expect(
      client.prepareContext(config, {
        system: '角色',
        messages: [{ id: 'u1', role: 'user', content: '非常长'.repeat(2000) }],
      }),
    ).rejects.toMatchObject({ code: 'context_length' });
  });

  test('failed summarization does not mutate caller history or persisted summary candidates', async () => {
    const input: ContextInput = {
      system: '角色',
      messages: history(24, 70),
      summary: '原来的摘要',
      summaryMessageId: 'm1',
      keepRecentMessages: 4,
    };
    const before = JSON.stringify(input);
    await expect(
      prepareContextWith(config, input, async () => {
        throw new Error('summary provider unavailable');
      }),
    ).rejects.toThrow('summary provider unavailable');
    expect(JSON.stringify(input)).toBe(before);
  });

  test('shared summaries never receive a character private memory or persona', async () => {
    const privateMemory = 'PRIVATE_MEMORY_ONLY_FOR_CHARACTER_A';
    const privatePersona = 'PRIVATE_PERSONA_ONLY_FOR_CHARACTER_A';
    const messages = history(20, 70);
    const first = await prepareContextWith(
      config,
      {
        system: privatePersona,
        memory: privateMemory,
        messages,
        keepRecentMessages: 4,
      },
      async (_config, input) => {
        const outgoing = JSON.stringify(input);
        expect(outgoing).not.toContain(privateMemory);
        expect(outgoing).not.toContain(privatePersona);
        return '共享场景：角色们在图书馆讨论一本古籍。';
      },
    );
    const second = await prepareContextWith(
      config,
      {
        system: 'CHARACTER_B',
        memory: 'MEMORY_B',
        messages,
        summary: first.summary,
        summaryMessageId: first.summaryMessageId,
      },
      async () => {
        throw new Error('The shared summary should already fit');
      },
    );
    expect(second.system).toContain(first.summary);
    expect(second.system).toContain('MEMORY_B');
    expect(second.system).not.toContain(privateMemory);
    expect(second.system).not.toContain(privatePersona);
  });

  test('budgets summary calls and carries a candidate across multiple chunks', async () => {
    const calls: GenerateInput[] = [];
    const result = await prepareContextWith(
      config,
      { system: '角色', messages: history(30, 120), keepRecentMessages: 2 },
      async (_config, input) => {
        calls.push(input);
        return `第${calls.length}阶段的准确摘要。`;
      },
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[1].messages[0].content).toContain('第1阶段的准确摘要');
    expect(result.summaryMessageId).toBe('m27');
    expect(result.estimatedTokens).toBeLessThanOrEqual(config.contextWindow);
  });
});
