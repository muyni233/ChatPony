import {
  prepareContextWith,
  contextError,
  estimateInputTokens,
  tokenSafetyMargin,
} from './context';
import {
  AIError,
  abortedError,
  httpError,
  isTimeoutSignal,
  normalizeAIError,
  withSignal,
} from './errors';
import { buildRequest, parseProtocolChunk } from './protocols';
import { assertSafeProviderUrl, validateProviderUrl } from './security';
import { readBoundedText, readSSE } from './sse';
import type { AIClient, AIRuntime, GenerateInput, ProviderConfig } from './types';

function checkInput(config: ProviderConfig, input: GenerateInput): void {
  if (
    !config.apiKey ||
    config.apiKey.length > 16_384 ||
    /[\r\n]/.test(config.apiKey) ||
    !config.model ||
    config.model.length > 256 ||
    /[\u0000-\u001f]/.test(config.model) ||
    !Number.isInteger(config.contextWindow) ||
    config.contextWindow < 1024 ||
    config.contextWindow > 2_000_000 ||
    !Number.isInteger(config.maxOutputTokens) ||
    config.maxOutputTokens < 1 ||
    !Number.isFinite(config.temperature) ||
    config.temperature < 0 ||
    config.temperature > 2
  ) {
    throw new AIError('configuration', '模型服务配置不完整或无效，请联系管理员。');
  }
  if (
    typeof input.system !== 'string' ||
    !Array.isArray(input.messages) ||
    input.messages.length === 0 ||
    input.messages.some(
      (message) =>
        !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' ||
        !message.content.trim(),
    ) ||
    (input.maxTokens !== undefined &&
      (!Number.isInteger(input.maxTokens) || input.maxTokens < 1)) ||
    (input.temperature !== undefined &&
      (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2))
  ) {
    throw new AIError('configuration', '模型请求参数无效。', { status: 400 });
  }
  const maxTokens = Math.min(input.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens);
  if (
    estimateInputTokens(input.system, input.messages) +
      maxTokens +
      tokenSafetyMargin(config.contextWindow) >
    config.contextWindow
  )
    throw contextError();
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function parseJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new AIError(
      'invalid_response',
      '模型服务返回了无法解析的数据，请联系管理员检查 API 协议。',
    );
  }
}

export function createAIClient(runtime: AIRuntime = {}): AIClient {
  const timeoutMs = Math.max(1, Math.min(runtime.timeoutMs ?? 90_000, 10 * 60_000));
  const maxRetries = Math.max(0, Math.min(runtime.maxRetries ?? 2, 3));
  const maxResponseBytes = runtime.maxResponseBytes ?? 2 * 1024 * 1024;

  async function* generateText(
    config: ProviderConfig,
    input: GenerateInput,
    externalSignal?: AbortSignal,
  ): AsyncGenerator<string> {
    if (externalSignal?.aborted) throw abortedError(isTimeoutSignal(externalSignal));
    checkInput(config, input);
    const requestOptions = {
      ...runtime,
      allowPrivateUrls: config.allowPrivateUrls ?? runtime.allowPrivateUrls ?? false,
    };
    const request = buildRequest(config, input, requestOptions);
    const baseUrl = validateProviderUrl(config.baseUrl, requestOptions);
    const controller = new AbortController();
    let timedOut = false,
      emitted = false;
    const abort = () => {
      timedOut = isTimeoutSignal(externalSignal);
      controller.abort(externalSignal?.reason);
    };
    externalSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const signal = controller.signal;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          if (signal.aborted) throw abortedError(timedOut);
          await assertSafeProviderUrl(baseUrl, requestOptions, signal);
          const response = await withSignal(
            (runtime.fetch ?? globalThis.fetch)(request.url, {
              method: 'POST',
              headers: request.headers,
              body: JSON.stringify(request.body),
              signal,
              redirect: 'manual',
              cache: 'no-store',
            }),
            signal,
          );
          if (!response.ok) {
            // Discard upstream error bodies: they can contain prompts, keys or proxy internals.
            void response.body?.cancel().catch(() => undefined);
            throw httpError(response.status, response.headers.get('retry-after'));
          }
          if (!response.body) throw new AIError('invalid_response', '模型服务返回了空响应。');
          const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
          let completed = false;
          if (contentType.includes('application/json')) {
            const body = parseJSON(await readBoundedText(response.body, signal, maxResponseBytes));
            const result = parseProtocolChunk(config.protocol, body);
            if (result.text) {
              emitted = true;
              yield result.text;
            }
            completed = true;
          } else if (contentType.includes('text/event-stream')) {
            for await (const event of readSSE(response.body, signal, {
              maxResponseBytes,
              maxEventBytes: runtime.maxEventBytes,
            })) {
              if (signal.aborted) throw abortedError(timedOut);
              if (event.data.trim() === '[DONE]') {
                completed = true;
                break;
              }
              if (!event.data.trim()) continue;
              const result = parseProtocolChunk(
                config.protocol,
                parseJSON(event.data),
                event.event,
                emitted,
              );
              if (result.text) {
                emitted = true;
                yield result.text;
              }
              if (result.done) {
                completed = true;
                break;
              }
            }
          } else {
            void response.body.cancel().catch(() => undefined);
            throw new AIError('invalid_response', '模型服务返回的格式与所选 API 协议不匹配。');
          }
          if (!completed)
            throw new AIError(
              'invalid_response',
              '模型回复在完成前中断，本轮回复尚未保存，请重试。',
            );
          if (!emitted)
            throw new AIError('invalid_response', '模型没有返回文本内容，请重试或检查模型配置。');
          return;
        } catch (cause) {
          const error = normalizeAIError(cause, signal, timedOut);
          if (!error.retryable || emitted || attempt >= maxRetries || signal.aborted) throw error;
          const retryDelay =
            error.retryAfterMs ?? Math.min(5000, (runtime.retryBaseMs ?? 500) * 2 ** attempt);
          try {
            await withSignal((runtime.sleep ?? sleep)(retryDelay, signal), signal);
          } catch (sleepError) {
            throw normalizeAIError(sleepError, signal, timedOut);
          }
        }
      }
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  async function completeText(
    config: ProviderConfig,
    input: GenerateInput,
    signal?: AbortSignal,
  ): Promise<string> {
    let result = '';
    for await (const text of generateText(config, input, signal)) result += text;
    return result;
  }

  return {
    generateText,
    completeText,
    prepareContext: (config, input, signal) =>
      prepareContextWith(config, input, completeText, signal),
  };
}
