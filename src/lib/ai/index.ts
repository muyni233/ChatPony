// Node-only imports in this module intentionally prevent use in a client bundle.
import { createAIClient } from './client';

const client = createAIClient();
export const generateText = client.generateText;
export const completeText = client.completeText;
export const prepareContext = client.prepareContext;

export { createAIClient } from './client';
export { AIError, normalizeAIError } from './errors';
export { validateProviderUrl, assertSafeProviderUrl, isPublicIPAddress } from './security';
export { estimateTokens, estimateInputTokens, truncateToTokenBudget } from './context';
export type {
  AIClient,
  AIMessage,
  AIRuntime,
  ProviderConfig,
  GenerateInput,
  ContextInput,
  ContextMessage,
  PreparedContext,
} from './types';
export type { AIErrorCode } from './errors';
