export type InsightsConfig = {
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
};

const number = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Read once per container. A missing key is a configuration, not an error: it
 * is the state a fresh clone runs in, and the report has to be complete in it.
 *
 * The timeout and the output cap are the cost ceiling, expressed in the two
 * units that actually bound one call. The ceiling on what is *sent* is the
 * ranking's own cap, in `similar-groups.sql.ts`.
 */
export const readInsightsConfig = (
  env: NodeJS.ProcessEnv = process.env,
): InsightsConfig => ({
  apiKey: env['ANTHROPIC_API_KEY']?.trim() || null,
  model: env['INSIGHTS_MODEL']?.trim() || 'claude-haiku-4-5',
  timeoutMs: number(env['INSIGHTS_TIMEOUT_MS'], 15_000),
  maxOutputTokens: number(env['INSIGHTS_MAX_OUTPUT_TOKENS'], 2_000),
});
