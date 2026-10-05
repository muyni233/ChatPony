import { AIError, providerEventError } from './errors';
import { validateProviderUrl } from './security';
import type { AIMessage, AIRuntime, GenerateInput, ProviderConfig } from './types';

const TURN_CUE = '请根据以上对话，以你当前扮演的角色回应这一轮。';

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mergeMessages(messages: AIMessage[], requireUserEnd: boolean): AIMessage[] {
  const result: AIMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const source = messages[index];
    const message =
      requireUserEnd && index === 0 && source.role === 'assistant'
        ? { role: 'user' as const, content: `先前角色发言（历史背景）：\n${source.content}` }
        : source;
    const previous = result.at(-1);
    if (previous?.role === message.role) previous.content += `\n\n${message.content}`;
    else result.push({ ...message });
  }
  if (requireUserEnd && result.at(-1)?.role === 'assistant')
    result.push({ role: 'user', content: TURN_CUE });
  return result;
}

export function buildRequest(
  config: ProviderConfig,
  input: GenerateInput,
  runtime: Pick<AIRuntime, 'allowPrivateUrls'> = {},
): {
  url: URL;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const url = validateProviderUrl(config.baseUrl, runtime);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  const maxTokens = Math.min(input.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens);
  const temperature = input.temperature ?? config.temperature;
  const path =
    url.pathname.replace(/\/+$/, '') || (config.protocol === 'gemini' ? '/v1beta' : '/v1');
  const reasoningModel = /^(o[1-9](?:-|$)|gpt-5(?:[.\-]|$))/i.test(config.model);
  const append = (suffix: string) => {
    url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  };
  switch (config.protocol) {
    case 'anthropic':
      append('/messages');
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      return {
        url,
        headers,
        body: {
          model: config.model,
          system: input.system,
          messages: mergeMessages(input.messages, true),
          max_tokens: maxTokens,
          temperature: Math.min(temperature, 1),
          stream: true,
        },
      };
    case 'openai-chat':
      append('/chat/completions');
      headers.Authorization = `Bearer ${config.apiKey}`;
      return {
        url,
        headers,
        body: {
          model: config.model,
          messages: [
            ...(input.system ? [{ role: 'system', content: input.system }] : []),
            ...mergeMessages(input.messages, false),
          ],
          // Older compatible gateways still require max_tokens; reasoning models use the newer field.
          ...(reasoningModel
            ? { max_completion_tokens: maxTokens }
            : { max_tokens: maxTokens, temperature }),
          stream: true,
        },
      };
    case 'openai-responses':
      append('/responses');
      headers.Authorization = `Bearer ${config.apiKey}`;
      return {
        url,
        headers,
        body: {
          model: config.model,
          instructions: input.system,
          input: mergeMessages(input.messages, false),
          max_output_tokens: maxTokens,
          ...(!reasoningModel ? { temperature } : {}),
          stream: true,
          store: false,
        },
      };
    case 'gemini': {
      const model = config.model.replace(/^models\//, '');
      url.pathname = `${path}/models/${encodeURIComponent(model)}:streamGenerateContent`;
      url.searchParams.set('alt', 'sse');
      headers['x-goog-api-key'] = config.apiKey;
      return {
        url,
        headers,
        body: {
          ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
          contents: mergeMessages(input.messages, true).map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          generationConfig: { maxOutputTokens: maxTokens, temperature },
        },
      };
    }
    default:
      throw new AIError('configuration', '不支持此模型 API 协议，请联系管理员检查配置。');
  }
}

function filtered(): never {
  throw new AIError('content_filtered', '模型未能回复本次内容，请调整消息后重试。', {
    status: 422,
  });
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  return array(value)
    .map((part) => {
      const item = object(part);
      if (item.type === 'refusal' || item.refusal) return filtered();
      return typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

export interface ParsedChunk {
  text: string;
  done?: boolean;
}

export function parseProtocolChunk(
  protocol: ProviderConfig['protocol'],
  value: unknown,
  event = 'message',
  hasText = false,
): ParsedChunk {
  const payload = object(value);
  if (payload.error) throw providerEventError(payload.error);
  if (event === 'error') throw providerEventError(payload);
  switch (protocol) {
    case 'anthropic': {
      const type = payload.type ?? event;
      if (type === 'error') throw providerEventError(payload.error);
      if (type === 'content_block_delta') {
        const delta = object(payload.delta);
        return {
          text: delta.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : '',
        };
      }
      if (type === 'content_block_start') {
        const block = object(payload.content_block);
        return { text: block.type === 'text' && typeof block.text === 'string' ? block.text : '' };
      }
      if (type === 'message_delta' && object(payload.delta).stop_reason === 'refusal') filtered();
      if (type === 'message_stop') return { text: '', done: true };
      if (payload.type === 'message' || Array.isArray(payload.content)) {
        if (payload.stop_reason === 'refusal') filtered();
        return { text: textContent(payload.content), done: true };
      }
      return { text: '' };
    }
    case 'openai-chat': {
      const choice = object(array(payload.choices)[0]);
      if (choice.finish_reason === 'content_filter') filtered();
      const delta = object(choice.delta);
      if (delta.refusal || object(choice.message).refusal) filtered();
      return {
        text: textContent(delta.content ?? object(choice.message).content),
        done: !!choice.finish_reason,
      };
    }
    case 'openai-responses': {
      const type = payload.type ?? event;
      if (type === 'response.failed' || type === 'error')
        throw providerEventError(object(payload.response).error ?? payload.error ?? payload);
      if (type === 'response.refusal.delta' || type === 'response.refusal.done') filtered();
      if (type === 'response.output_text.delta')
        return { text: typeof payload.delta === 'string' ? payload.delta : '' };
      if (
        type === 'response.completed' ||
        type === 'response.incomplete' ||
        Array.isArray(payload.output)
      ) {
        const response = Object.keys(object(payload.response)).length
          ? object(payload.response)
          : payload;
        if (response.status === 'failed' || response.error)
          throw providerEventError(response.error);
        if (object(response.incomplete_details).reason === 'content_filter') filtered();
        const text = hasText
          ? ''
          : array(response.output)
              .map((item) => textContent(object(item).content))
              .join('');
        return { text, done: true };
      }
      return { text: '' };
    }
    case 'gemini': {
      if (object(payload.promptFeedback).blockReason) filtered();
      const candidate = object(array(payload.candidates)[0]);
      const reason = candidate.finishReason;
      if (
        ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'].includes(String(reason))
      )
        filtered();
      if (reason && !['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(String(reason))) {
        throw new AIError('invalid_response', '模型没有完成有效回复，请调整消息后重试。');
      }
      const parts = array(object(candidate.content).parts);
      return {
        text: parts
          .map((part) => {
            const item = object(part);
            return !item.thought && typeof item.text === 'string' ? item.text : '';
          })
          .join(''),
        done: !!reason,
      };
    }
  }
}
