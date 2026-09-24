import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnthropicProvider } from './anthropic.adapter.js';
import type { InsightsConfig } from './config.js';
import { readInsightsConfig } from './config.js';
import { ModelGroupings } from './port.js';
import { createLogger } from '../../shared/logging/logger.js';

const log = createLogger('silent');

// The adapter's obligations: a request timeout, exactly one retry, a cost
// ceiling, the last report cached, and the prompt in a versioned file. It is
// exercised against a local HTTP server standing in for the API: no key of ours is used
// and no request leaves the machine, but every byte the adapter would send is
// inspectable, which a mocked SDK would hide.

type Attempt = { path: string; body: Record<string, unknown> };
type Reply = { status: number; text?: string; json?: unknown; delayMs?: number };

const NAMES = ['City Cabs', 'Metro Transit', 'Maple Street Hardware'];

const message = (text: string): unknown => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'test-model',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

const grouping = JSON.stringify({
  groups: [
    { label: 'Getting around', payees: ['City Cabs', 'Metro Transit'] },
    { label: 'Home improvement', payees: ['Maple Street Hardware'] },
  ],
});

let server: Server;
let attempts: Attempt[] = [];
let replies: Reply[] = [];
let baseUrlBefore: string | undefined;

const config = (overrides: Partial<InsightsConfig> = {}): InsightsConfig => ({
  apiKey: 'test-key-never-real',
  model: 'test-model',
  timeoutMs: 2_000,
  maxOutputTokens: 512,
  ...overrides,
});

beforeEach(async () => {
  attempts = [];
  replies = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      attempts.push({
        path: req.url ?? '',
        body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });

      const reply = replies[attempts.length - 1] ?? replies.at(-1) ?? { status: 200 };
      const send = (): void => {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.text ?? JSON.stringify(reply.json ?? message(grouping)));
      };
      if (reply.delayMs === undefined) send();
      else setTimeout(send, reply.delayMs);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrlBefore = process.env['ANTHROPIC_BASE_URL'];
  process.env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (baseUrlBefore === undefined) delete process.env['ANTHROPIC_BASE_URL'];
  else process.env['ANTHROPIC_BASE_URL'] = baseUrlBefore;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the LlmProvider port — what may leave the process', () => {
  it('sends the merchant names and nothing else', async () => {
    replies = [{ status: 200 }];
    await createAnthropicProvider(config(), log).groupPayees(NAMES);

    expect(attempts).toHaveLength(1);
    const body = attempts[0]?.body ?? {};
    const serialised = JSON.stringify(body);

    for (const name of NAMES) expect(serialised).toContain(name);
    // No amount, no date, no account, no identity — the port's signature takes
    // names, and this is the assertion that the signature is the whole truth.
    expect(serialised).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(serialised).not.toMatch(/amount|minor|balance|owner|account/i);
  });

  it('carries the versioned prompt file, not a template literal', async () => {
    replies = [{ status: 200 }];
    await createAnthropicProvider(config(), log).groupPayees(NAMES);

    const body = attempts[0]?.body as { messages?: { content?: string }[] };
    const prompt = body.messages?.[0]?.content ?? '';

    expect(prompt).toContain('<merchant-names>');
    expect(prompt).toContain(NAMES.join('\n'));
    expect(prompt, 'the placeholder was not filled').not.toContain('{{NAMES}}');
    expect(prompt, 'the names must be carried as data').toContain('data, not instruction');
  });

  it('bounds one call by the configured model and output ceiling', async () => {
    replies = [{ status: 200 }];
    await createAnthropicProvider(config({ maxOutputTokens: 321 }), log).groupPayees(NAMES);

    const body = attempts[0]?.body ?? {};
    expect(body['model']).toBe('test-model');
    expect(body['max_tokens']).toBe(321);
    expect(
      (body['output_config'] as { format?: { type?: string } } | undefined)?.format?.type,
      'the model answers a schema, not free text',
    ).toBe('json_schema');
  });

  it('returns the grouping the model answered', async () => {
    replies = [{ status: 200 }];
    const result = await createAnthropicProvider(config(), log).groupPayees(NAMES);

    expect(result).toEqual(ModelGroupings.parse(JSON.parse(grouping)));
  });
});

describe('the retry fires exactly once', () => {
  it('makes a second attempt after a failure, and only a second', async () => {
    replies = [{ status: 500, json: { error: 'overloaded' } }, { status: 200 }];
    const result = await createAnthropicProvider(config(), log).groupPayees(NAMES);

    expect(attempts).toHaveLength(2);
    expect(result.groups).toHaveLength(2);
  });

  it('gives up after the retry rather than hammering the API', async () => {
    replies = [{ status: 500, json: { error: 'overloaded' } }];
    await expect(createAnthropicProvider(config(), log).groupPayees(NAMES)).rejects.toThrow();

    expect(attempts).toHaveLength(2);
  });

  it('does not retry a call that succeeded', async () => {
    replies = [{ status: 200 }];
    await createAnthropicProvider(config(), log).groupPayees(NAMES);

    expect(attempts).toHaveLength(1);
  });

  it('times out, retries once, and rejects rather than hanging', async () => {
    replies = [{ status: 200, delayMs: 5_000 }];
    const started = Date.now();

    await expect(
      createAnthropicProvider(config({ timeoutMs: 200 }), log).groupPayees(NAMES),
    ).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(4_000);
    expect(attempts).toHaveLength(2);
  });
});

describe('the model’s answer is validated, not trusted', () => {
  it('refuses a response that is not the grouping schema', async () => {
    replies = [{ status: 200, json: message(JSON.stringify({ groups: [{ label: 7 }] })) }];

    await expect(createAnthropicProvider(config(), log).groupPayees(NAMES)).rejects.toThrow();
    expect(attempts).toHaveLength(2);
  });

  it('refuses a response that is not JSON at all', async () => {
    replies = [{ status: 200, json: message('Here are your groups! Transport: City Cabs.') }];

    await expect(createAnthropicProvider(config(), log).groupPayees(NAMES)).rejects.toThrow();
  });

  it('refuses a response with no content to parse', async () => {
    replies = [
      {
        status: 200,
        json: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ];

    await expect(createAnthropicProvider(config(), log).groupPayees(NAMES)).rejects.toThrow();
  });
});

describe('with no API key', () => {
  it('reports itself unavailable and calls nobody', async () => {
    const provider = createAnthropicProvider(config({ apiKey: null }), log);

    expect(provider.available).toBe(false);
    await expect(provider.groupPayees(NAMES)).rejects.toThrow();
    expect(attempts).toEqual([]);
  });

  it('reads an absent key as no key, not as an error', () => {
    expect(readInsightsConfig({}).apiKey).toBeNull();
    expect(readInsightsConfig({ ANTHROPIC_API_KEY: '   ' }).apiKey).toBeNull();
    expect(readInsightsConfig({ ANTHROPIC_API_KEY: 'sk-x' }).apiKey).toBe('sk-x');
  });
});

describe('ModelGroupings — the whole of what the model may answer', () => {
  it('accepts a label and the names under it', () => {
    const parsed = ModelGroupings.parse({ groups: [{ label: 'Eating out', payees: ['A'] }] });
    expect(parsed.groups[0]?.payees).toEqual(['A']);
  });

  it.each([
    ['no groups key', {}],
    ['a group with no label', { groups: [{ payees: ['A'] }] }],
    ['an empty label', { groups: [{ label: '', payees: ['A'] }] }],
    ['a label of 61 characters', { groups: [{ label: 'x'.repeat(61), payees: ['A'] }] }],
    ['a group with no payees', { groups: [{ label: 'Empty', payees: [] }] }],
    ['a non-string payee', { groups: [{ label: 'Odd', payees: [1] }] }],
    [
      'more than thirty groups',
      { groups: Array.from({ length: 31 }, (_, i) => ({ label: `G${i}`, payees: ['A'] })) },
    ],
  ])('rejects %s', (_label, value) => {
    expect(ModelGroupings.safeParse(value).success).toBe(false);
  });

  it('gives the model nowhere to put a figure', () => {
    const parsed = ModelGroupings.parse({
      groups: [{ label: 'Rides', payees: ['A'], totalMinor: '999999', rank: 1 }],
    });

    expect(JSON.stringify(parsed)).not.toContain('999999');
    expect(Object.keys(parsed.groups[0] ?? {})).toEqual(['label', 'payees']);
  });
});
