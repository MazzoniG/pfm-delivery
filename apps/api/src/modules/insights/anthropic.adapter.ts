import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Logger } from '../../shared/logging/logger.js';
import { ModelGroupings, type LlmProvider } from './port.js';
import type { InsightsConfig } from './config.js';

const PROMPT_VERSION = 'spending-report.v1.md';

/**
 * The prompt is a file, not a template literal: it is the part of this feature
 * most likely to be edited by someone who is not editing TypeScript, and its
 * version is in its name so a change to it is visible in a diff and in a review.
 */
const readPrompt = (): string =>
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts', PROMPT_VERSION),
    'utf8',
  );

/**
 * One call, one retry, then give up — the service degrades on the throw. Two
 * attempts is the shape of the failure being retried: a transient network or
 * overload blip. A model that answers something unusable twice is not going to
 * answer usefully on a third attempt, and the user is waiting.
 *
 * `maxRetries: 0` on the client because the retry lives here, where it can be
 * counted by a test; leaving the SDK's own two in place would make "exactly one
 * retry" quietly mean six attempts.
 */
export const createAnthropicProvider = (
  config: InsightsConfig,
  log: Logger,
): LlmProvider => {
  if (config.apiKey === null) {
    return {
      available: false,
      groupPayees: () => Promise.reject(new Error('no ANTHROPIC_API_KEY configured')),
    };
  }

  // Read once, at construction: the prompt is a deployed artifact, not a file
  // the running process is watching.
  const prompt = readPrompt();

  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: 0,
  });

  const ask = async (names: string[]): Promise<ModelGroupings> => {
    const response = await client.messages.parse({
      model: config.model,
      max_tokens: config.maxOutputTokens,
      messages: [
        {
          role: 'user',
          content: prompt.replace('{{NAMES}}', names.join('\n')),
        },
      ],
      output_config: { format: zodOutputFormat(ModelGroupings) },
    });

    if (response.parsed_output === null) {
      throw new Error('model response did not match the grouping schema');
    }
    return response.parsed_output;
  };

  return {
    available: true,
    groupPayees: async (names) => {
      try {
        return await ask(names);
      } catch (error) {
        // Logged rather than swallowed: a permanent failure — a rejected key,
        // a model id that does not exist — is retried like a blip, and without
        // this only the second error is ever seen.
        log.info({ err: error }, 'semantic grouping attempt failed, retrying once');
        return await ask(names);
      }
    },
  };
};
