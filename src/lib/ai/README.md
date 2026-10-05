# ChatPony AI runtime

This directory is server-only TypeScript. Production code uses Web `fetch`, Web Streams, Node DNS and IP utilities; there is no provider SDK or Bun-specific production dependency. Credentials are provided by the backend after decrypting the stored provider configuration.

## Backend contract

```ts
import { prepareContext, generateText, AIError } from '@/lib/ai';

const prepared = await prepareContext(
  providerWithSecret,
  {
    system: characterPrompt,
    messages: fullHistoryIncludingPendingUserMessage,
    memory: characterMemory,
    summary: storedSummary,
    summaryMessageId: storedSummaryMessageId,
  },
  signal,
);

let reply = '';
for await (const text of generateText(providerWithSecret, prepared, signal)) {
  reply += text;
  // Send a delta to the authenticated owner of this conversation.
}
// Only after successful completion, commit reply and the returned summary + marker.
// A group turn should commit all replies and its final summary together.
```

`completeText(config, input, signal?)` collects a successful generation. `createAIClient(runtime)` provides isolated fetch/DNS/sleep dependencies for offline tests. Runtime overrides must never be accepted from public request bodies.

`ProviderConfig` contains `protocol`, `baseUrl`, `model`, `apiKey`, `contextWindow`, `maxOutputTokens`, `temperature`, and the optional `allowPrivateUrls` admin setting. No environment variable is required. An explicit `false` is authoritative.

## Protocols

| Value              | Endpoint appended to a versioned base URL       | Notes                                                                                                                                                                      |
| ------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`        | `/messages`                                     | Separate system field, `x-api-key`, Anthropic version header; temperature limited to 1.                                                                                    |
| `openai-chat`      | `/chat/completions`                             | Chat Completions, not the obsolete plain-text `/completions` endpoint. Known GPT-5/o-series reasoning models use `max_completion_tokens` and omit unsupported temperature. |
| `openai-responses` | `/responses`                                    | Instructions plus message input, `store: false`, `max_output_tokens`; completed event output is not duplicated.                                                            |
| `gemini`           | `/models/{model}:streamGenerateContent?alt=sse` | Native contents/parts and system instruction. API key is in a header, never a query parameter.                                                                             |

For an origin-only base URL, `/v1` is used for Anthropic/OpenAI and `/v1beta` for Gemini. Versioned proxy prefixes are preserved. Anthropic and OpenAI may also use their complete endpoint URL. Adjacent messages with the same role are joined. Anthropic/Gemini get an explicit turn cue when the final history item is an assistant message, which supports sequential group conversations without relying on assistant prefill.

## Failure and context behavior

- SSE supports fragmented UTF-8, LF/CRLF/CR line endings, multiline data, comments, and a final unterminated frame. Both frame and complete response byte sizes are bounded. Thinking parts are not displayed.
- Streams must reach a protocol completion marker. Premature EOF, safety stops, malformed data and empty text are errors; incomplete replies must not be persisted as completed messages.
- One generation has a 90-second deadline, including retries. External aborts stop DNS waits, requests, stream reads and retry delays. Configure a caller-owned deadline for an entire group turn or multi-step summary operation.
- Only 429 and recognized upstream 5xx/overload errors are retried, up to twice, and only before the first emitted text. Retry-After is bounded to 30 seconds. Raw HTTP error bodies and upstream error strings are never returned or logged.
- Token counting is a conservative multilingual heuristic, not a model tokenizer. It reserves output tokens plus 4%/128-token minimum safety space. Prompt memories and summaries are clipped; the recent message window is preserved. If that window alone is too large, the request fails with an actionable error rather than dropping the latest user message.
- Compression is incremental, merges an existing summary, and processes old history in bounded chunks (at most 12 summary calls). It returns a candidate summary and the last covered message ID. No persistence occurs here. Missing/stale markers are ignored safely. Summary failures leave input data untouched.

## Network boundary

Provider addresses must be HTTP(S), without credentials, fragments, arbitrary query strings or control characters. By default literal and DNS-resolved private, local, multicast and reserved addresses are denied; every DNS record must be public. Redirects are disabled so credentials cannot follow a redirect to a different host. Only an administrator can enable private API URLs in the platform settings.

Native fetch performs its own connection lookup after DNS preflight. Therefore DNS rebinding is not eliminated by application validation alone. Production deployments should also restrict outbound access to internal/metadata networks at the network or proxy layer when provider hosts are not trusted. Do not present application DNS validation as a replacement for an outbound firewall.

Tests use mock streams and no real keys or paid model calls: `bun test tests/ai.test.ts tests/ai-context.test.ts`.
