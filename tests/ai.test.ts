import { describe, expect, test } from 'bun:test';
import {
  AIError,
  createAIClient,
  isPublicIPAddress,
  validateProviderUrl,
  assertSafeProviderUrl,
} from '../src/lib/ai';
import { buildRequest } from '../src/lib/ai/protocols';
import { readSSE } from '../src/lib/ai/sse';
import type { AIRuntime, GenerateInput, ProviderConfig } from '../src/lib/ai';

const config: ProviderConfig = {
  protocol: 'openai-chat',
  baseUrl: 'https://api.example.com/v1',
  model: 'example-model',
  apiKey: 'test-secret-not-for-browser',
  contextWindow: 8192,
  maxOutputTokens: 1024,
  temperature: 0.8,
};
const input: GenerateInput = {
  system: '你是暮光闪闪。',
  messages: [{ role: 'user', content: '你好！' }],
};
const safeRuntime = (options: AIRuntime = {}): AIRuntime => ({
  resolveHostname: async () => [{ address: '1.1.1.1', family: 4 }],
  maxRetries: 0,
  ...options,
});

function rawResponse(text: string, fragmentBytes = 7): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += fragmentBytes)
          controller.enqueue(bytes.slice(i, i + fragmentBytes));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );
}

function response(events: unknown[]): Response {
  return rawResponse(
    events
      .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
      .join(''),
  );
}

function fetcher(
  run: (url: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => run(url, init)) as typeof fetch;
}

async function failure(work: Promise<unknown>): Promise<AIError> {
  try {
    await work;
    throw new Error('Expected a failure');
  } catch (error) {
    expect(error).toBeInstanceOf(AIError);
    return error as AIError;
  }
}

describe('native protocol mappings', () => {
  test('Anthropic uses a separate system and x-api-key, merging adjacent roles', () => {
    const request = buildRequest(
      { ...config, protocol: 'anthropic' },
      {
        ...input,
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'A' },
          { role: 'assistant', content: 'B' },
        ],
      },
    );
    expect(request.url.href).toBe('https://api.example.com/v1/messages');
    expect(request.headers['x-api-key']).toBe(config.apiKey);
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.body.system).toBe(input.system);
    expect(request.body.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'A\n\nB' },
      { role: 'user', content: '请根据以上对话，以你当前扮演的角色回应这一轮。' },
    ]);
  });

  test('Chat Completions and Responses use their own token and instruction fields', () => {
    const chat = buildRequest(config, input);
    expect(chat.url.pathname).toBe('/v1/chat/completions');
    expect(chat.body.messages).toEqual([
      { role: 'system', content: input.system },
      ...input.messages,
    ]);
    expect(chat.body.max_tokens).toBe(1024);
    expect(chat.headers.Authorization).toBe(`Bearer ${config.apiKey}`);
    const responses = buildRequest(
      { ...config, protocol: 'openai-responses' },
      { ...input, maxTokens: 128 },
    );
    expect(responses.url.pathname).toBe('/v1/responses');
    expect(responses.body.instructions).toBe(input.system);
    expect(responses.body.input).toEqual(input.messages);
    expect(responses.body.max_output_tokens).toBe(128);
    expect(responses.body.store).toBe(false);
  });

  test('reasoning Chat Completions models omit unsupported temperature and max_tokens', () => {
    const request = buildRequest({ ...config, model: 'gpt-5' }, input);
    expect(request.body.max_completion_tokens).toBe(1024);
    expect(request.body.max_tokens).toBeUndefined();
    expect(request.body.temperature).toBeUndefined();
  });

  test('Gemini keeps its key out of URLs and maps model roles', () => {
    const request = buildRequest(
      {
        ...config,
        protocol: 'gemini',
        baseUrl: 'https://api.example.com/v1beta',
        model: 'models/gemini-model',
      },
      {
        ...input,
        messages: [
          { role: 'user', content: '初次见面' },
          { role: 'assistant', content: '欢迎' },
          ...input.messages,
        ],
      },
    );
    expect(request.url.href).toBe(
      'https://api.example.com/v1beta/models/gemini-model:streamGenerateContent?alt=sse',
    );
    expect(request.headers['x-goog-api-key']).toBe(config.apiKey);
    expect(request.body.contents).toEqual([
      { role: 'user', parts: [{ text: '初次见面' }] },
      { role: 'model', parts: [{ text: '欢迎' }] },
      { role: 'user', parts: [{ text: '你好！' }] },
    ]);
    expect(request.body.systemInstruction).toEqual({ parts: [{ text: input.system }] });
    expect(request.url.href.includes(config.apiKey)).toBe(false);
  });

  test('explicit endpoints are not duplicated and root endpoints get conventional versions', () => {
    expect(
      buildRequest({ ...config, baseUrl: 'https://api.example.com/v1/chat/completions' }, input).url
        .pathname,
    ).toBe('/v1/chat/completions');
    expect(
      buildRequest({ ...config, baseUrl: 'https://api.example.com/' }, input).url.pathname,
    ).toBe('/v1/chat/completions');
  });

  test('an initial character greeting remains available without an invalid initial assistant turn', () => {
    const request = buildRequest(
      { ...config, protocol: 'anthropic' },
      {
        ...input,
        messages: [{ role: 'assistant', content: '欢迎来到小马谷。' }, ...input.messages],
      },
    );
    expect(request.body.messages).toEqual([
      { role: 'user', content: '先前角色发言（历史背景）：\n欢迎来到小马谷。\n\n你好！' },
    ]);
  });
});

describe('bounded SSE parsing and completion', () => {
  test('handles every byte boundary, CRLF, multiline data, comments and UTF-8', async () => {
    const stream = rawResponse(
      ': ping\r\nevent: chunk\r\ndata: {"text":\r\ndata: "你好🦄"}\r\n\r\ndata: [DONE]',
      1,
    );
    const events = [];
    for await (const event of readSSE(stream.body!)) events.push(event);
    expect(events).toEqual([
      { event: 'chunk', data: '{"text":\n"你好🦄"}' },
      { event: 'message', data: '[DONE]' },
    ]);
  });

  test.each([
    [
      'openai-chat',
      [
        { choices: [{ delta: { content: '你好' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
    ],
    [
      'anthropic',
      [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
        { type: 'message_stop' },
      ],
    ],
    [
      'openai-responses',
      [
        { type: 'response.output_text.delta', delta: '你好' },
        { type: 'response.completed', response: { output: [{ content: [{ text: '你好' }] }] } },
      ],
    ],
    [
      'gemini',
      [
        {
          candidates: [
            { content: { parts: [{ text: 'hidden', thought: true }, { text: '你好' }] } },
          ],
        },
        { candidates: [{ finishReason: 'STOP' }] },
      ],
    ],
  ] as const)('streams %s without duplicating final output', async (protocol, events) => {
    const client = createAIClient(
      safeRuntime({
        fetch: fetcher((_url, init) => {
          expect(init?.redirect).toBe('manual');
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return response([...events]);
        }),
      }),
    );
    expect(await client.completeText({ ...config, protocol }, input)).toBe('你好');
  });

  test('supports JSON from compatible gateways', async () => {
    const client = createAIClient(
      safeRuntime({
        fetch: fetcher(() =>
          Response.json({ choices: [{ message: { content: '完整内容' }, finish_reason: 'stop' }] }),
        ),
      }),
    );
    expect(await client.completeText(config, input)).toBe('完整内容');
  });

  test('does not accept an unexpectedly truncated stream', async () => {
    const client = createAIClient(
      safeRuntime({
        fetch: fetcher(() => response([{ choices: [{ delta: { content: 'partial' } }] }])),
      }),
    );
    expect((await failure(client.completeText(config, input))).code).toBe('invalid_response');
  });

  test('caps bytes and malformed protocol data without exposing raw content', async () => {
    const client = createAIClient(
      safeRuntime({
        maxResponseBytes: 60,
        fetch: fetcher(() => response([{ choices: [{ delta: { content: 'x'.repeat(100) } }] }])),
      }),
    );
    expect((await failure(client.completeText(config, input))).code).toBe('response_too_large');
    const malformed = createAIClient(
      safeRuntime({ fetch: fetcher(() => rawResponse(`data: secret ${config.apiKey}\n\n`)) }),
    );
    const error = await failure(malformed.completeText(config, input));
    expect(error.code).toBe('invalid_response');
    expect(error.message).not.toContain(config.apiKey);
  });

  test('event byte limits also apply to multibyte text without newlines', async () => {
    const client = createAIClient(
      safeRuntime({
        maxEventBytes: 70,
        fetch: fetcher(() => rawResponse(`data: ${'你'.repeat(40)}`)),
      }),
    );
    expect((await failure(client.completeText(config, input))).code).toBe('response_too_large');
  });

  test('normalizes provider safety and response.failed events', async () => {
    const blocked = createAIClient(
      safeRuntime({
        fetch: fetcher(() => response([{ promptFeedback: { blockReason: 'SAFETY' } }])),
      }),
    );
    expect(
      (await failure(blocked.completeText({ ...config, protocol: 'gemini' }, input))).code,
    ).toBe('content_filtered');
    const failed = createAIClient(
      safeRuntime({
        fetch: fetcher(() =>
          response([
            {
              type: 'response.failed',
              response: { error: { code: 'server_error', message: config.apiKey } },
            },
          ]),
        ),
      }),
    );
    const error = await failure(
      failed.completeText({ ...config, protocol: 'openai-responses' }, input),
    );
    expect(error.code).toBe('upstream_unavailable');
    expect(error.message).not.toContain(config.apiKey);
  });
});

describe('retry, cancellation and timeouts', () => {
  test('retries 429/5xx before output, respecting Retry-After', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const client = createAIClient(
      safeRuntime({
        maxRetries: 2,
        sleep: async (delay) => {
          delays.push(delay);
        },
        fetch: fetcher(() =>
          ++attempts === 1
            ? new Response('private upstream message', {
                status: 429,
                headers: { 'Retry-After': '2' },
              })
            : attempts === 2
              ? new Response('', { status: 503 })
              : response([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
        ),
      }),
    );
    expect(await client.completeText(config, input)).toBe('ok');
    expect(attempts).toBe(3);
    expect(delays).toEqual([2000, 1000]);
  });

  test('never retries once text has reached the caller', async () => {
    let attempts = 0;
    const client = createAIClient(
      safeRuntime({
        maxRetries: 3,
        fetch: fetcher(() => {
          attempts++;
          return response([
            { choices: [{ delta: { content: 'partial' } }] },
            { error: { type: 'overloaded_error' } },
          ]);
        }),
      }),
    );
    const generator = client.generateText(config, input);
    expect((await generator.next()).value).toBe('partial');
    expect((await failure(generator.next())).code).toBe('upstream_unavailable');
    expect(attempts).toBe(1);
  });

  test('does not retry 401, redirects, or unclassified network failures', async () => {
    for (const status of [401, 302, 400]) {
      let calls = 0;
      const client = createAIClient(
        safeRuntime({
          maxRetries: 3,
          fetch: fetcher(() => {
            calls++;
            return new Response(config.apiKey, { status });
          }),
        }),
      );
      const error = await failure(client.completeText(config, input));
      expect(error.message).not.toContain(config.apiKey);
      expect(calls).toBe(1);
    }
  });

  test('pre-abort prevents any request and abort interrupts a stalled read', async () => {
    let calls = 0;
    const before = new AbortController();
    before.abort();
    const client = createAIClient(
      safeRuntime({
        fetch: fetcher(() => {
          calls++;
          return new Response(new ReadableStream(), {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }),
      }),
    );
    expect((await failure(client.completeText(config, input, before.signal))).code).toBe(
      'cancelled',
    );
    expect(calls).toBe(0);
    const during = new AbortController();
    const work = client.completeText(config, input, during.signal);
    setTimeout(() => during.abort(), 5);
    expect((await failure(work)).code).toBe('cancelled');
  });

  test('timeout covers a fetch implementation that ignores the abort signal', async () => {
    const client = createAIClient(
      safeRuntime({ timeoutMs: 8, fetch: fetcher(() => new Promise<Response>(() => undefined)) }),
    );
    expect((await failure(client.completeText(config, input))).code).toBe('timeout');
  });

  test('a caller deadline is reported as timeout rather than a user cancellation', async () => {
    const client = createAIClient(
      safeRuntime({ fetch: fetcher(() => new Promise<Response>(() => undefined)) }),
    );
    const signal = AbortSignal.timeout(8);
    expect((await failure(client.completeText(config, input, signal))).code).toBe('timeout');
    expect((await failure(client.completeText(config, input, signal))).code).toBe('timeout');
    expect(
      (
        await failure(
          client.prepareContext(
            config,
            {
              system: input.system,
              messages: [{ id: 'u1', ...input.messages[0] }],
            },
            signal,
          ),
        )
      ).code,
    ).toBe('timeout');
  });

  test('consumes a fetch rejection when cancellation wins during fetch startup', async () => {
    const controller = new AbortController();
    const client = createAIClient(
      safeRuntime({
        fetch: fetcher(() => {
          controller.abort();
          return Promise.reject(new Error('upstream connection was cancelled'));
        }),
      }),
    );
    expect((await failure(client.completeText(config, input, controller.signal))).code).toBe(
      'cancelled',
    );
    // Give the losing fetch rejection a turn; it must not become an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('server-side API URL defenses', () => {
  test.each([
    'file:///etc/passwd',
    'https://user:pass@api.example.com/v1',
    'https://api.example.com/v1?key=secret',
    'https://api.example.com/#x',
    'http://localhost:9000/v1',
    'http://127.1/v1',
    'http://2130706433',
    'http://169.254.169.254/',
    'http://10.1.1.1',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'http://service.internal/v1',
    'https://api.example.com/%0d%0aheader',
  ])('rejects unsafe URL %s', (url) => {
    expect(() => validateProviderUrl(url)).toThrow(AIError);
  });

  test('checks all DNS records, including mixed public/private responses', async () => {
    await expect(
      assertSafeProviderUrl(new URL(config.baseUrl), {
        resolveHostname: async () => [
          { address: '1.1.1.1', family: 4 },
          { address: '192.168.1.2', family: 4 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'unsafe_url' });
    expect(isPublicIPAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIPAddress('2001:db8::1')).toBe(false);
    expect(isPublicIPAddress('::ffff:7f00:1')).toBe(false);
    expect(isPublicIPAddress('100.64.0.1')).toBe(false);
  });

  test('private API override is explicit and config false remains authoritative', async () => {
    expect(
      validateProviderUrl('http://localhost:9000/v1', { allowPrivateUrls: true }).hostname,
    ).toBe('localhost');
    const client = createAIClient({
      allowPrivateUrls: true,
      fetch: fetcher(() =>
        response([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
      ),
    });
    expect(
      await client.completeText(
        { ...config, baseUrl: 'http://localhost:9000/v1', allowPrivateUrls: true },
        input,
      ),
    ).toBe('ok');
    expect(
      (
        await failure(
          client.completeText(
            { ...config, baseUrl: 'http://localhost:9000/v1', allowPrivateUrls: false },
            input,
          ),
        )
      ).code,
    ).toBe('unsafe_url');
  });
});
