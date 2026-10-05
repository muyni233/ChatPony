import { Buffer } from 'node:buffer';
import { AIError, withSignal } from './errors';

export interface SSEEvent {
  event: string;
  data: string;
}

export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  limits: {
    maxResponseBytes?: number;
    maxEventBytes?: number;
  } = {},
): AsyncGenerator<SSEEvent> {
  const maxResponseBytes = limits.maxResponseBytes ?? 2 * 1024 * 1024;
  const maxEventBytes = limits.maxEventBytes ?? 256 * 1024;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    event = 'message',
    eventSize = 0,
    bytes = 0,
    finished = false;
  let data: string[] = [];
  const tooLarge = () => new AIError('response_too_large', '模型返回内容过大，已停止接收。');
  const parseLine = (line: string): SSEEvent | undefined => {
    if (line === '') {
      const frame = data.length ? { event, data: data.join('\n') } : undefined;
      data = [];
      event = 'message';
      eventSize = 0;
      return frame;
    }
    eventSize += Buffer.byteLength(line, 'utf8') + 1;
    if (eventSize > maxEventBytes) throw tooLarge();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const key = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (key === 'event') event = value;
    if (key === 'data') data.push(value);
  };
  try {
    while (!finished) {
      const chunk = await withSignal(reader.read(), signal);
      finished = chunk.done;
      if (chunk.value) bytes += chunk.value.byteLength;
      if (bytes > maxResponseBytes) throw tooLarge();
      try {
        buffer += decoder.decode(chunk.value, { stream: !finished });
      } catch {
        throw new AIError('invalid_response', '模型服务返回了无效的文本编码。');
      }
      let cursor = 0;
      for (let index = 0; index < buffer.length; index++) {
        const char = buffer[index];
        if (char !== '\r' && char !== '\n') continue;
        if (char === '\r' && index === buffer.length - 1 && !finished) break;
        const frame = parseLine(buffer.slice(cursor, index));
        if (char === '\r' && buffer[index + 1] === '\n') index++;
        cursor = index + 1;
        if (frame) yield frame;
      }
      buffer = buffer.slice(cursor);
      if (Buffer.byteLength(buffer, 'utf8') + eventSize > maxEventBytes) throw tooLarge();
    }
    if (buffer) {
      const frame = parseLine(buffer);
      if (frame) yield frame;
    }
    const last = parseLine('');
    if (last) yield last;
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* An aborted read may still hold the lock. */
    }
  }
}

export async function readBoundedText(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    output = '',
    finished = false;
  try {
    while (!finished) {
      const chunk = await withSignal(reader.read(), signal);
      finished = chunk.done;
      if (chunk.value) bytes += chunk.value.byteLength;
      if (bytes > maxBytes)
        throw new AIError('response_too_large', '模型返回内容过大，已停止接收。');
      try {
        output += decoder.decode(chunk.value, { stream: !finished });
      } catch {
        throw new AIError('invalid_response', '模型服务返回了无效的文本编码。');
      }
    }
    return output;
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* The signal may have interrupted a pending read. */
    }
  }
}
