import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  buildModelRequest,
  StreamAccumulator,
  streamText,
  type ModelProvider,
} from '../src/lib/ai/protocols';
import { actionSegments } from '../src/lib/display';
import { parseStructuredMemories, queryTerms, similarity } from '../src/lib/ai/memory';
import type { Protocol } from '../src/lib/types';

function provider(protocol: Protocol, capabilities: ModelProvider['capabilities'] = ['text']) {
  return {
    id: 'p',
    supplierId: 'supplier',
    supplierActive: true,
    name: 'Test model',
    protocol,
    baseUrl: 'https://example.com',
    model: 'test-model',
    kind: 'language',
    capabilities,
    reasoningEffort: 'default',
    thinkingBudget: null,
    apiKey: 'k',
    hasKey: true,
    active: true,
    contextWindow: 8192,
    maxOutput: 512,
    temperature: null,
    createdAt: '',
  } satisfies ModelProvider;
}
const image = { mime: 'image/webp', data: 'AAAA' };
const withImage = {
  system: 's',
  messages: [{ role: 'user' as const, content: '看看这张图', images: [image] }],
};

describe('multimodal request bodies', () => {
  test('each protocol uses its native image part', () => {
    const anthropic = buildModelRequest(provider('anthropic'), withImage).body as any;
    expect(anthropic.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: 'AAAA' },
    });
    const chat = buildModelRequest(provider('openai-completions'), withImage).body as any;
    expect(chat.messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/webp;base64,AAAA' },
    });
    const responses = buildModelRequest(provider('openai-responses'), withImage).body as any;
    expect(responses.input[0].content[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/webp;base64,AAAA',
    });
    const gemini = buildModelRequest(provider('gemini'), withImage).body as any;
    expect(gemini.contents[0].parts[0]).toEqual({
      inline_data: { mime_type: 'image/webp', data: 'AAAA' },
    });
  });
  test('text-only turns keep plain string content', () => {
    const body = buildModelRequest(provider('openai-completions'), {
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    }).body as any;
    expect(body.messages[1].content).toBe('hi');
    expect(body.stream).toBe(false);
  });
  test('stream requests switch flags and the Gemini endpoint', () => {
    const chat = buildModelRequest(provider('openai-completions'), withImage, { stream: true });
    expect((chat.body as any).stream).toBe(true);
    expect((chat.body as any).stream_options).toEqual({ include_usage: true });
    const gemini = buildModelRequest(provider('gemini'), withImage, { stream: true });
    expect(gemini.url).toContain(':streamGenerateContent?alt=sse');
  });
});

describe('stream parsing', () => {
  test('accumulates deltas for all four protocols', () => {
    const anthropic = new StreamAccumulator('anthropic');
    anthropic.push({ type: 'message_start', message: { usage: { input_tokens: 9 } } });
    anthropic.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } });
    anthropic.push({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'x' },
    });
    anthropic.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } });
    anthropic.push({
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: { output_tokens: 2 },
    });
    expect(anthropic.result()).toEqual({ text: '你好', truncated: true });
    expect(anthropic.inputTokens).toBe(9);

    const chat = new StreamAccumulator('openai-completions');
    chat.push({ choices: [{ delta: { content: '  Hi' } }] });
    chat.push({ choices: [{ delta: { content: ' there' }, finish_reason: 'stop' }] });
    chat.push({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    expect(chat.result().text).toBe('Hi there');
    expect(chat.outputTokens).toBe(2);

    const responses = new StreamAccumulator('openai-responses');
    responses.push({ type: 'response.output_text.delta', delta: 'A' });
    responses.push({
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    expect(responses.result().text).toBe('A');

    const gemini = new StreamAccumulator('gemini');
    gemini.push({
      candidates: [{ content: { parts: [{ text: '思考', thought: true }, { text: 'B' }] } }],
    });
    gemini.push({ candidates: [{ content: { parts: [{ text: 'C' }] }, finishReason: 'STOP' }] });
    expect(gemini.result().text).toBe('BC');
  });
  test('content filter and empty output fail safely', () => {
    expect(() =>
      new StreamAccumulator('openai-completions').push({
        choices: [{ delta: {}, finish_reason: 'content_filter' }],
      }),
    ).toThrow();
    expect(() => new StreamAccumulator('anthropic').result()).toThrow();
  });
  test('streamText reads SSE, and falls back to JSON when a provider ignores stream', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"一"}}]}\n\n',
      ': keep-alive\n\n',
      'data: {"choices":[{"delta":{"content":"二"}}]}\r\n\r\n',
      'data: [DONE]\n\n',
    ];
    const deltas: string[] = [];
    const result = await streamText(provider('openai-completions'), withImage, {
      onDelta: (text) => deltas.push(text),
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const part of sse) controller.enqueue(new TextEncoder().encode(part));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    expect(result.text).toBe('一二');
    expect(deltas).toEqual(['一', '二']);
    const fallback: string[] = [];
    const json = await streamText(provider('openai-completions'), withImage, {
      onDelta: (text) => fallback.push(text),
      fetcher: async () =>
        Response.json({ choices: [{ message: { content: '整段' }, finish_reason: 'stop' }] }),
    });
    expect(json.text).toBe('整段');
    expect(fallback).toEqual(['整段']);
  });
});

describe('action display', () => {
  test('marks *actions* and （actions） without touching **bold**', () => {
    expect(actionSegments('*摇摇尾巴* 你好呀（笑）', {})).toEqual([
      { kind: 'action', text: '摇摇尾巴' },
      { kind: 'text', text: ' 你好呀' },
      { kind: 'action', text: '笑' },
    ]);
    expect(actionSegments('这是 **重点** 内容', {})).toEqual([
      { kind: 'text', text: '这是 **重点** 内容' },
    ]);
    expect(actionSegments('未闭合 *动作', {})).toEqual([{ kind: 'text', text: '未闭合 *动作' }]);
    expect(actionSegments('*点头*', { actionHideMarkers: false, actionMarkers: ['* *'] })).toEqual([
      { kind: 'action', text: '*点头*' },
    ]);
    expect(actionSegments('*点头*', { actionStyleEnabled: false })).toEqual([
      { kind: 'text', text: '*点头*' },
    ]);
  });
});

describe('memory helpers', () => {
  test('query terms, similarity and structured parsing', () => {
    const terms = queryTerms('我想吃苹果派');
    expect(terms.trigrams).toContain('苹果派');
    expect(queryTerms('苹果').bigrams).toEqual(['苹果']);
    expect(similarity('我喜欢吃苹果', '我喜欢吃苹果。')).toBeGreaterThan(0.8);
    expect(similarity('我喜欢吃苹果', '今天天气很好')).toBe(0);
    const parsed = parseStructuredMemories(
      '```json\n{"summary":"去了果园","memories":[{"content":"用户喜欢苹果","kind":"preference","importance":8,"tags":["水果"]},{"content":"x"}]}\n```',
    );
    expect(parsed?.summary).toBe('去了果园');
    expect(parsed?.memories).toEqual([
      { content: '用户喜欢苹果', kind: 'preference', importance: 0.8, tags: ['水果'], ttlDays: 0 },
    ]);
    expect(parseStructuredMemories('普通总结文本')).toBeNull();
  });
});

test('memory lifecycle and attachments integration', async () => {
  const child = Bun.spawn(
    [process.execPath, 'run', resolve(import.meta.dir, 'fixtures/memory-lifecycle-check.ts')],
    {
      env: {
        ...process.env,
        DATABASE_PATH: ':memory:',
        ENCRYPTION_KEY: '52'.repeat(32),
        NODE_ENV: 'test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Memory lifecycle failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain('MEMORY_LIFECYCLE_OK');
}, 30_000);
