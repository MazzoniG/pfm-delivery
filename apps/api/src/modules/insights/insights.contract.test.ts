import type { Server } from 'node:http';
import request, { type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountBalanceResponse,
  Entry,
  InsightsSettings,
  LedgerAccount,
  MAX_REPORT_MONTHS,
  SpendingReport,
  apiPath,
  routes,
} from '@pfm/contracts';
import { seedId } from '../../../prisma/seed/ids.js';
import { addDays, addMonths, startOfMonth, todayUtc } from '../../../prisma/seed/time.js';
import { createApp } from '../../app.js';
import { createContainer, type Container } from '../../container.js';
import {
  ALICE,
  ALICE_ACCOUNTS,
  BLAKE,
  BLAKE_ACCOUNTS,
  BLAKE_PROJECT_ID,
  startHarness,
  uniqueName,
  type Harness,
} from '../../test/harness.js';
import { closeServer, listenOnLoopback } from '../../test/loopback.js';
import { expectProblem, expectValidationProblem } from '../../test/problem.js';
import { createReportingService } from '../reporting/service.js';
import { createAnthropicProvider } from './anthropic.adapter.js';
import { createReportCache, type ReportCache } from './cache.js';
import { createInsightsController } from './controller.js';
import type { LlmProvider, ModelGroupings } from './port.js';
import { createInsightsRepository } from './repository.js';
import { createInsightsService, type SemanticReport } from './service.js';

// US6 — "a report that group the similar transactions and highlight the more
// expensives". Every figure asserted here is derived independently from the
// rows in the database, summed in BigInt, and compared against the endpoint.
// No money value passes through a JS `number`, and no model is ever called:
// the `LlmProvider` port is stubbed, and the stub records what it was given.

const reportPath = apiPath(routes.insightsSpendingReport);
const settingsPath = apiPath(routes.insightsSettings);
const entriesPath = apiPath(routes.entries);

type Report = SpendingReport;
type NameReport = Extract<Report, { grouping: 'name' }>;
type MeaningReport = Extract<Report, { grouping: 'meaning' }>;

const iso = (value: Date): string => value.toISOString().slice(0, 10);
const asDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

const TODAY_DATE = todayUtc();
const CURRENT = startOfMonth(TODAY_DATE);
/** The seeded history: six months ending with the current one. */
const SEEDED = {
  from: iso(addMonths(CURRENT, -5)),
  to: iso(TODAY_DATE),
};
/** Far outside every other suite's windows, so these fixtures disturb nothing. */
const FIXTURE = { from: '2010-03-01', to: '2010-03-31' };

/**
 * The payee matching rule: case-folded, punctuation and whitespace collapsed,
 * and the trailing terminal reference a card network appends dropped — which
 * is what makes
 * "AMAZON MKTP" and "Amazon Mktp*2A1" one merchant. Written here from the rule
 * rather than read from the SQL, so the two can disagree.
 */
const normalise = (payee: string): string =>
  payee
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/( [a-z0-9]*[0-9][a-z0-9]*)+$/, '');

type Derived = {
  key: string;
  total: bigint;
  entries: Set<string>;
  categories: Set<string>;
  spellings: Set<string>;
};

let h: Harness;
let container: Container;
const servers: Server[] = [];

/** Every reportable expense line of an owner, grouped by the rule above. */
const derive = async (
  ownerId: string,
  from: string,
  to: string,
  projectId?: string,
): Promise<Map<string, Derived>> => {
  const lines = await h.db.entryLine.findMany({
    where: {
      excludedFromReporting: false,
      ledgerAccount: { ownerId, kind: 'expense' },
      entry: { ownerId, occurredOn: { gte: asDate(from), lte: asDate(to) } },
      ...(projectId === undefined ? {} : { projectId }),
    },
    select: {
      entryId: true,
      amountMinor: true,
      ledgerAccount: { select: { name: true } },
      entry: { select: { payee: true } },
    },
  });

  const out = new Map<string, Derived>();
  for (const line of lines) {
    const payee = line.entry.payee?.trim() ?? '';
    if (payee === '') continue;
    const key = normalise(payee);
    const row = out.get(key) ?? {
      key,
      total: 0n,
      entries: new Set<string>(),
      categories: new Set<string>(),
      spellings: new Set<string>(),
    };
    row.total += line.amountMinor;
    row.entries.add(line.entryId);
    row.categories.add(line.ledgerAccount.name);
    row.spellings.add(payee);
    out.set(key, row);
  }
  return out;
};

const rank = (derived: Map<string, Derived>): Derived[] =>
  [...derived.values()].sort((a, b) =>
    a.total === b.total ? a.key.localeCompare(b.key) : a.total > b.total ? -1 : 1,
  );

type Stub = LlmProvider & {
  calls: string[][];
  reply(fn: (names: string[]) => ModelGroupings | Promise<ModelGroupings>): void;
};

const stubProvider = (available = true): Stub => {
  const calls: string[][] = [];
  let reply: (names: string[]) => ModelGroupings | Promise<ModelGroupings> = (names) => ({
    groups: [{ label: 'Everything', payees: [...names] }],
  });
  return {
    available,
    calls,
    reply: (fn) => {
      reply = fn;
    },
    groupPayees: async (names) => {
      calls.push([...names]);
      return reply(names);
    },
  };
};

type Mounted = {
  alice: Server;
  blake: Server;
  provider: Stub;
  cache: ReportCache<SemanticReport>;
};

const serve = async (app: ReturnType<typeof createApp>): Promise<Server> => {
  const server = await listenOnLoopback(app);
  servers.push(server);
  return server;
};

/**
 * Both owners against one service instance, which is how the container wires
 * it: one process, one cache, identity from the `currentUser` seam.
 */
// Insights reads ranked merchants and never projects, so the expansion port
// the reporting service takes for the bills page is never reached from here.
const noProjection = {
  expandThrough: (): Promise<void> =>
    Promise.reject(new Error('insights never asks for a projection')),
};

const mount = async (provider: Stub = stubProvider()): Promise<Mounted> => {
  const cache = createReportCache<SemanticReport>();
  const controller = createInsightsController(
    createInsightsService(
      createReportingService(container.db, noProjection),
      createInsightsRepository(container.db),
      provider,
      container.log,
      cache,
    ),
  );
  return {
    alice: await serve(createApp({ ...container, currentUserId: ALICE, insights: controller })),
    blake: await serve(createApp({ ...container, currentUserId: BLAKE, insights: controller })),
    provider,
    cache,
  };
};

const postReport = (app: Server, body: Record<string, unknown>): Test =>
  request(app).post(reportPath).send(body);

const reportOf = async (
  app: Server,
  body: Record<string, unknown>,
): Promise<{ raw: Record<string, unknown>; report: Report }> => {
  const res = await postReport(app, body);
  expect(res.status).toBe(200);
  return { raw: res.body as Record<string, unknown>, report: SpendingReport.parse(res.body) };
};

const nameReport = async (
  app: Server,
  body: Record<string, unknown>,
): Promise<NameReport> => {
  const { report } = await reportOf(app, body);
  expect(report.grouping).toBe('name');
  return report as NameReport;
};

/** Parsed reports hold `bigint`, which `JSON.stringify` refuses on its own. */
const wireOf = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) => (typeof inner === 'bigint' ? inner.toString() : inner));

const sumOfGroups = (report: Report): bigint =>
  report.groups.reduce((total, group) => total + group.totalMinor, 0n);

/**
 * The invariant the whole feature rests on: the groups on screen add up to the
 * total on screen. `insight.ts` — "every figure in it is a SQL sum, so the
 * totals reconcile whether the client adds them or not"; and groups that do not
 * sum to the deterministic total fall back to name matching.
 */
const expectReconciles = (report: Report): void => {
  expect(sumOfGroups(report), 'groups must sum to the report total').toBe(report.totalMinor);
};

const meaningReport = async (
  app: Server,
  body: Record<string, unknown>,
): Promise<MeaningReport> => {
  const { report } = await reportOf(app, body);
  expect(report.grouping).toBe('meaning');
  expectReconciles(report);
  return report as MeaningReport;
};

const setConsent = async (app: Server, enabled: boolean): Promise<InsightsSettings> => {
  const res = await request(app).put(settingsPath).send({ enabled });
  expect(res.status).toBe(200);
  return InsightsSettings.parse(res.body);
};

const postEntry = async (
  body: Record<string, unknown>,
  app: Server = h.app,
): Promise<Entry> => {
  const res = await request(app).post(entriesPath).send(body);
  expect([200, 201]).toContain(res.status);
  return Entry.parse(res.body);
};

const createExpense = async (label: string): Promise<{ id: string; name: string }> => {
  const name = uniqueName(label);
  const row = await h.db.ledgerAccount.create({
    data: { ownerId: ALICE, name, kind: 'expense' },
    select: { id: true },
  });
  return { id: row.id, name };
};

const PROBE = {
  a: { id: '', name: '' },
  b: { id: '', name: '' },
  funding: '',
};

const spend = async (
  occurredOn: string,
  payee: string | null,
  categoryId: string,
  amountMinor: string,
  fundedBy: string,
): Promise<Entry> =>
  postEntry({
    occurredOn,
    payee,
    lines: [
      { ledgerAccountId: categoryId, amountMinor },
      { ledgerAccountId: fundedBy, amountMinor: (-BigInt(amountMinor)).toString() },
    ],
  });

beforeAll(async () => {
  h = await startHarness();
  container = createContainer();

  PROBE.a = await createExpense('Insights Probe A');
  PROBE.b = await createExpense('Insights Probe B');

  const account = await request(h.app)
    .post(apiPath(routes.accounts))
    .send({ name: uniqueName('Insights Funding'), kind: 'asset' });
  expect([200, 201]).toContain(account.status);
  PROBE.funding = LedgerAccount.parse(account.body).id;

  await spend('2010-03-02', 'Zenith Tools', PROBE.a.id, '15000', PROBE.funding);
  await spend('2010-03-04', 'AMAZON MKTP', PROBE.a.id, '1200', PROBE.funding);
  await spend('2010-03-05', 'Amazon Mktp*2A1', PROBE.a.id, '2500', PROBE.funding);
  await spend('2010-03-06', 'Amazon Mktp', PROBE.b.id, '300', PROBE.funding);
  await spend('2010-03-11', 'Solo Merchant', PROBE.b.id, '900', PROBE.funding);
  await spend('2010-03-12', null, PROBE.a.id, '7777', PROBE.funding);

  // A merchant refunded more than it charged: genuinely negative, never absolute.
  await spend('2010-03-08', 'Aurora Refunds Ltd', PROBE.a.id, '5000', PROBE.funding);
  await spend('2010-03-09', 'Aurora Refunds Ltd', PROBE.a.id, '-9000', PROBE.funding);

  // $110 at the clinic, $60 of it reimbursed: out of the report, in the balance.
  await postEntry({
    occurredOn: '2010-03-07',
    payee: 'Lakeside Clinic',
    lines: [
      { ledgerAccountId: PROBE.a.id, amountMinor: '5000' },
      { ledgerAccountId: PROBE.a.id, amountMinor: '6000', excludedFromReporting: true },
      { ledgerAccountId: PROBE.funding, amountMinor: '-11000' },
    ],
  });
});

afterAll(async () => {
  await container.db.user.updateMany({
    where: { id: { in: [ALICE, BLAKE] } },
    data: { semanticGroupingConsentedAt: null },
  });
  await Promise.all(servers.map(closeServer));
  await container.db.$disconnect();
  await h.close();
});

describe('the deterministic report — grouping and ranking, derived independently', () => {
  it('returns every payee of the fixture period, ranked largest first', async () => {
    const apps = await mount();
    const derived = await derive(ALICE, FIXTURE.from, FIXTURE.to);
    const report = await nameReport(apps.alice, FIXTURE);

    expect(derived.size).toBe(5);
    expect(report.groups).toHaveLength(derived.size);

    const keys = report.groups.map((g) => normalise(g.payee));
    expect(new Set(keys).size, 'a payee appears twice').toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(derived.keys()));

    for (const group of report.groups) {
      const want = derived.get(normalise(group.payee));
      expect(want, `${group.payee} was not derived`).toBeDefined();
      expect(group.totalMinor, `${group.payee} total`).toBe(want?.total);
      expect(group.transactionCount, `${group.payee} count`).toBe(want?.entries.size);
      expect(new Set(group.categories), `${group.payee} categories`).toEqual(want?.categories);
      expect(want?.spellings.has(group.payee), 'the shown spelling is one of the data').toBe(true);
    }

    const totals = report.groups.map((g) => g.totalMinor);
    for (let i = 1; i < totals.length; i += 1) {
      expect((totals[i - 1] ?? 0n) >= (totals[i] ?? 0n), `out of rank at ${i}`).toBe(true);
    }
    expect(totals).toEqual(rank(derived).map((d) => d.total));
  });

  it('gives the period a total that equals the derived total of the groups shown', async () => {
    const apps = await mount();
    const derived = await derive(ALICE, FIXTURE.from, FIXTURE.to);
    let want = 0n;
    for (const row of derived.values()) want += row.total;

    const report = await nameReport(apps.alice, FIXTURE);
    expect(report.totalMinor).toBe(want);
    expect(report.totalMinor).toBe(20_900n);
    expectReconciles(report);
  });

  it('matches the seeded six months, and truncates by rank when it truncates', async () => {
    const apps = await mount();
    const derived = await derive(ALICE, SEEDED.from, SEEDED.to);
    const report = await nameReport(apps.alice, SEEDED);

    expect(derived.size).toBeGreaterThan(10);
    expect(report.groups.length).toBeGreaterThan(0);

    const shown = new Set<string>();
    for (const group of report.groups) {
      const key = normalise(group.payee);
      const want = derived.get(key);
      expect(want, `${group.payee} was not derived`).toBeDefined();
      expect(group.totalMinor, `${group.payee} total`).toBe(want?.total);
      expect(group.transactionCount).toBe(want?.entries.size);
      expect(new Set(group.categories)).toEqual(want?.categories);
      shown.add(key);
    }
    expect(shown.size).toBe(report.groups.length);

    const smallestShown = report.groups.at(-1)?.totalMinor ?? 0n;
    for (const [key, row] of derived) {
      if (shown.has(key)) continue;
      expect(row.total <= smallestShown, `${key} outranks a shown group`).toBe(true);
    }
  });

  it('is stable across runs on the deterministic seed', async () => {
    const apps = await mount();
    const first = await postReport(apps.alice, SEEDED);
    const second = await postReport(apps.alice, SEEDED);

    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('counts one entry once however many categories it was split across', async () => {
    const apps = await mount();
    const report = await nameReport(apps.alice, FIXTURE);
    const amazon = report.groups.find((g) => normalise(g.payee) === 'amazon mktp');

    // Three statement spellings of one merchant, booked to two categories.
    expect(amazon?.transactionCount).toBe(3);
    expect(amazon?.totalMinor).toBe(4_000n);
    expect(new Set(amazon?.categories)).toEqual(new Set([PROBE.a.name, PROBE.b.name]));
  });

  it('merges AMAZON MKTP with Amazon Mktp*2A1 — the mock-up’s stated rule', async () => {
    const apps = await mount();
    const report = await nameReport(apps.alice, FIXTURE);
    const spellings = report.groups.map((g) => g.payee);

    expect(spellings.filter((p) => normalise(p) === 'amazon mktp')).toHaveLength(1);
    expect(spellings).not.toContain('Amazon Mktp*2A1');
  });

  it('puts every money figure on the wire as an integer string', async () => {
    const apps = await mount();
    const res = await postReport(apps.alice, FIXTURE);
    expect(res.status).toBe(200);

    const groups = (res.body as { totalMinor: unknown; groups: Record<string, unknown>[] });
    expect(typeof groups.totalMinor).toBe('string');
    expect(groups.totalMinor).toMatch(/^-?\d+$/);
    for (const group of groups.groups) {
      expect(typeof group['totalMinor']).toBe('string');
      expect(group['totalMinor']).toMatch(/^-?\d+$/);
      expect(typeof group['transactionCount']).toBe('number');
      expect(typeof group['isLargest']).toBe('boolean');
    }
  });

  it('carries an amount larger than Number.MAX_SAFE_INTEGER without loss', async () => {
    const apps = await mount();
    const huge = 9_007_199_254_740_993n;
    const category = await createExpense('Insights Huge');
    await spend('2010-04-02', 'Colossus Holdings', category.id, huge.toString(), PROBE.funding);

    const period = { from: '2010-04-01', to: '2010-04-30' };
    const res = await postReport(apps.alice, period);
    expect(res.status).toBe(200);
    const wire = (res.body as { groups: Record<string, unknown>[] }).groups.find(
      (g) => g['payee'] === 'Colossus Holdings',
    );
    expect(wire?.['totalMinor']).toBe(huge.toString());

    const report = await nameReport(apps.alice, period);
    expect(report.groups.find((g) => g.payee === 'Colossus Holdings')?.totalMinor).toBe(huge);
  });

  it('returns an empty report, not an error, for a period with no spending', async () => {
    const apps = await mount();
    const report = await nameReport(apps.alice, { from: '2009-01-01', to: '2009-01-31' });

    expect(report.groups).toEqual([]);
    expect(report.totalMinor).toBe(0n);
    expect(report.fallback).toBeNull();
  });

  it('leaves an entry with no payee out of the groups', async () => {
    const apps = await mount();
    const report = await nameReport(apps.alice, FIXTURE);

    expect(report.groups.map((g) => g.payee)).not.toContain('');
    for (const group of report.groups) expect(group.payee.trim()).not.toBe('');
    expect(report.totalMinor).toBe(20_900n);
  });
});

describe('highlighting the most expensive — the story’s own words', () => {
  it('marks exactly one group, and it is the largest', async () => {
    const apps = await mount();
    const report = await nameReport(apps.alice, FIXTURE);
    const marked = report.groups.filter((g) => g.isLargest);

    expect(marked).toHaveLength(1);
    expect(marked[0]?.payee).toBe('Zenith Tools');
    expect(marked[0]?.totalMinor).toBe(15_000n);
    expect(report.groups[0]?.isLargest).toBe(true);
  });

  it('never marks a negative group, and sorts it last — no Math.abs anywhere', async () => {
    const apps = await mount();
    const report = await nameReport(apps.alice, FIXTURE);
    const refunded = report.groups.find((g) => g.payee === 'Aurora Refunds Ltd');

    expect(refunded?.totalMinor).toBe(-4_000n);
    expect(refunded?.isLargest).toBe(false);
    expect(report.groups.at(-1)?.payee).toBe('Aurora Refunds Ltd');
  });

  it('marks nothing at all when the whole period nets out negative', async () => {
    const apps = await mount();
    const category = await createExpense('Insights Negative');
    await spend('2010-05-03', 'Returns Only Co', category.id, '-3000', PROBE.funding);

    const report = await nameReport(apps.alice, { from: '2010-05-01', to: '2010-05-31' });
    expect(report.groups.map((g) => g.totalMinor)).toEqual([-3_000n]);
    expect(report.groups.every((g) => !g.isLargest)).toBe(true);
  });
});

describe('the report is expenses only, and excluded lines are out of it', () => {
  it('never groups an income, asset, liability or equity payee', async () => {
    const apps = await mount();
    const report = await nameReport(apps.alice, SEEDED);
    const payees = report.groups.map((g) => g.payee);

    for (const kept of ['Acme Corp Payroll', 'Brightside Studio', 'High-Yield Savings']) {
      expect(payees, `${kept} is income`).not.toContain(kept);
    }
    for (const moved of ['Transfer', 'Visa Credit Card Payment', 'Balance Adjustment']) {
      expect(payees, `${moved} touches no expense account`).not.toContain(moved);
    }

    const categories = new Set(report.groups.flatMap((g) => g.categories));
    const expense = new Set(
      (
        await h.db.ledgerAccount.findMany({
          where: { ownerId: ALICE, kind: 'expense' },
          select: { name: true },
        })
      ).map((a) => a.name),
    );
    for (const name of categories) expect(expense.has(name), `${name} is not an expense`).toBe(true);
  });

  it('counts only the reported part of a partly reimbursed purchase', async () => {
    const apps = await mount();
    const report = await nameReport(apps.alice, FIXTURE);
    const clinic = report.groups.find((g) => g.payee === 'Lakeside Clinic');

    expect(clinic?.totalMinor).toBe(5_000n);
    expect(clinic?.transactionCount).toBe(1);
  });

  it('still moves the funding account’s balance by the whole amount', async () => {
    const res = await request(h.app).get(apiPath(routes.accountBalance(PROBE.funding)));
    expect(res.status).toBe(200);

    const derived = await h.db.entryLine.aggregate({
      where: { ledgerAccountId: PROBE.funding },
      _sum: { amountMinor: true },
    });
    expect(AccountBalanceResponse.parse(res.body).balanceMinor).toBe(derived._sum.amountMinor);
  });

  it('honours the seeded reimbursed lunch — $40 grouped, $60 not', async () => {
    const apps = await mount();
    const lunchOn = iso(addDays(TODAY_DATE, -10));
    const report = await nameReport(apps.alice, { from: lunchOn, to: lunchOn });
    const kettle = report.groups.find((g) => g.payee === 'The Copper Kettle');

    expect(kettle?.totalMinor).toBe(4_000n);
  });
});

describe('signs — the report looks from the expense side, once', () => {
  const period = { from: '2010-07-01', to: '2010-07-31' };
  let category = { id: '', name: '' };

  beforeAll(async () => {
    category = await createExpense('Insights Signs');
    // Same purchase, two funding sides: one asset, one liability.
    await spend('2010-07-03', 'Asset Funded Ltd', category.id, '2500', ALICE_ACCOUNTS.checking);
    await spend('2010-07-04', 'Card Funded Ltd', category.id, '3500', ALICE_ACCOUNTS.visa);
    // Income, not spending: it must not reach the report at all.
    await postEntry({
      occurredOn: '2010-07-05',
      payee: 'Payroll Probe Ltd',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '400000' },
        { ledgerAccountId: ALICE_ACCOUNTS.salary, amountMinor: '-400000' },
      ],
    });
  });

  it('shows spending paid by a credit card as positive, exactly as one paid from a bank', async () => {
    const apps = await mount();
    const report = await nameReport(apps.alice, period);
    const byPayee = new Map(report.groups.map((g) => [g.payee, g.totalMinor]));

    expect(byPayee.get('Card Funded Ltd')).toBe(3_500n);
    expect(byPayee.get('Asset Funded Ltd')).toBe(2_500n);
    expect(report.totalMinor).toBe(6_000n);
    expect(report.groups[0]?.payee).toBe('Card Funded Ltd');
  });

  it('leaves the card’s own balance owing — the report flips no other sign', async () => {
    const res = await request(h.app).get(apiPath(routes.accountBalance(ALICE_ACCOUNTS.visa)));
    expect(res.status).toBe(200);

    const raw = await h.db.entryLine.aggregate({
      where: { ledgerAccountId: ALICE_ACCOUNTS.visa },
      _sum: { amountMinor: true },
    });
    // A liability stores negative and displays positive: the DTO flip, not ABS.
    expect(AccountBalanceResponse.parse(res.body).balanceMinor).toBe(-(raw._sum.amountMinor ?? 0n));
  });

  it('never groups an income payee, however large', async () => {
    const apps = await mount();
    const report = await nameReport(apps.alice, period);

    expect(report.groups.map((g) => g.payee)).not.toContain('Payroll Probe Ltd');
    expect(report.totalMinor).toBe(6_000n);
    expect(report.groups.every((g) => g.totalMinor > 0n)).toBe(true);
  });
});

describe('the project filter', () => {
  const franceTrip = seedId(`project:${ALICE}:france-trip`);
  const period = { from: SEEDED.from, to: SEEDED.to };

  it('groups only the lines booked to the project', async () => {
    const apps = await mount();
    const derived = await derive(ALICE, period.from, period.to, franceTrip);
    const report = await nameReport(apps.alice, { ...period, projectId: franceTrip });

    expect(derived.size).toBeGreaterThan(0);
    expect(new Set(report.groups.map((g) => normalise(g.payee)))).toEqual(new Set(derived.keys()));
    for (const group of report.groups) {
      expect(group.totalMinor).toBe(derived.get(normalise(group.payee))?.total);
    }
  });

  it('answers zeros for another owner’s project id, confirming nothing', async () => {
    const apps = await mount();
    const res = await postReport(apps.alice, { ...period, projectId: BLAKE_PROJECT_ID });

    expect(JSON.stringify(res.body)).not.toMatch(/reef/i);
    if (res.status === 200) {
      const report = SpendingReport.parse(res.body);
      expect(report.groups).toEqual([]);
      expect(report.totalMinor).toBe(0n);
    } else {
      expectProblem(res, 404);
    }
  });
});

describe('tenancy — the grouping query returns nothing of the other tenant’s', () => {
  const shared = { from: iso(addMonths(CURRENT, -2)), to: iso(TODAY_DATE) };

  it('keeps B’s merchants and money out of A’s report', async () => {
    const apps = await mount();
    const res = await postReport(apps.alice, shared);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/reef/i);

    const report = SpendingReport.parse(res.body);
    expect(report.grouping).toBe('name');
    const derived = await derive(ALICE, shared.from, shared.to);
    for (const group of (report as NameReport).groups) {
      expect(group.totalMinor).toBe(derived.get(normalise(group.payee))?.total);
    }
  });

  it('serves B its own spending, derived from B’s rows only', async () => {
    const apps = await mount();
    const derived = await derive(BLAKE, shared.from, shared.to);
    const report = await nameReport(apps.blake, shared);

    expect(derived.size).toBeGreaterThan(0);
    expect(new Set(report.groups.map((g) => normalise(g.payee)))).toEqual(new Set(derived.keys()));
    expect(report.groups.map((g) => g.payee)).toContain('REEF Aquatics');
    for (const group of report.groups) {
      expect(group.totalMinor).toBe(derived.get(normalise(group.payee))?.total);
      expect(new Set(group.categories)).toEqual(derived.get(normalise(group.payee))?.categories);
    }
    expect(wireOf(report.groups)).not.toContain('Riverside');
  });

  it('does not move A’s report when B spends', async () => {
    const apps = await mount();
    const before = await postReport(apps.alice, shared);

    await postEntry(
      {
        occurredOn: iso(TODAY_DATE),
        payee: 'REEF splurge',
        accountId: BLAKE_ACCOUNTS.checking,
        categoryId: BLAKE_ACCOUNTS.spending,
        amountMinor: '-87654321',
      },
      await h.as(BLAKE),
    );

    const after = await postReport(apps.alice, shared);
    expect(after.body).toEqual(before.body);
  });

  it('does not leak A’s categories to B through a shared category name', async () => {
    const apps = await mount();
    const report = await nameReport(apps.blake, shared);
    const names = new Set(report.groups.flatMap((g) => g.categories));

    for (const name of names) {
      const owned = await h.db.ledgerAccount.count({
        where: { ownerId: BLAKE, name, kind: 'expense' },
      });
      expect(owned, `${name} is not B’s`).toBeGreaterThan(0);
    }
  });
});

describe('consent — nothing is sent before it', () => {
  it('reports the server’s key and the owner’s consent separately', async () => {
    const apps = await mount(stubProvider(true));
    await setConsent(apps.alice, false);

    const res = await request(apps.alice).get(settingsPath);
    expect(res.status).toBe(200);
    const settings = InsightsSettings.parse(res.body);

    expect(settings.semanticAvailable).toBe(true);
    expect(settings.enabled).toBe(false);
  });

  it('sends nothing, and says why, when consent has never been given', async () => {
    const apps = await mount();
    await setConsent(apps.alice, false);

    const report = await nameReport(apps.alice, { ...FIXTURE, grouping: 'meaning' });

    expect(apps.provider.calls).toEqual([]);
    expect(report.fallback).toBe('not-consented');
    expect(report.totalMinor).toBe(20_900n);
    expect(report.groups.length).toBeGreaterThan(0);
  });

  it('stops sending the moment consent is withdrawn', async () => {
    const apps = await mount();
    await setConsent(apps.alice, true);
    await meaningReport(apps.alice, { ...FIXTURE, grouping: 'meaning' });
    expect(apps.provider.calls).toHaveLength(1);

    await setConsent(apps.alice, false);
    const after = await nameReport(apps.alice, { ...FIXTURE, grouping: 'meaning' });

    expect(after.fallback).toBe('not-consented');
    expect(apps.provider.calls).toHaveLength(1);
  });

  it('keeps consent per owner — A turning it on does not turn it on for B', async () => {
    const apps = await mount();
    await setConsent(apps.alice, true);
    await setConsent(apps.blake, false);

    const blake = InsightsSettings.parse((await request(apps.blake).get(settingsPath)).body);
    const alice = InsightsSettings.parse((await request(apps.alice).get(settingsPath)).body);

    expect(alice.enabled).toBe(true);
    expect(blake.enabled).toBe(false);

    await postReport(apps.blake, { ...FIXTURE, grouping: 'meaning' });
    expect(apps.provider.calls).toEqual([]);
  });

  it('remembers consent across requests and instances', async () => {
    const first = await mount();
    await setConsent(first.alice, true);

    const second = await mount();
    const settings = InsightsSettings.parse((await request(second.alice).get(settingsPath)).body);
    expect(settings.enabled).toBe(true);
  });

  it('rejects a non-boolean consent with a 400 problem+json naming it', async () => {
    const apps = await mount();
    expectValidationProblem(await request(apps.alice).put(settingsPath).send({ enabled: 'yes' }), 'enabled');
    expectValidationProblem(await request(apps.alice).put(settingsPath).send({}), 'enabled');
  });
});

describe('semantic grouping — what the model may and may not do', () => {
  const meaningRequest = { ...FIXTURE, grouping: 'meaning' };

  const consented = async (): Promise<Mounted> => {
    const apps = await mount();
    await setConsent(apps.alice, true);
    return apps;
  };

  it('sends the merchant names, and nothing else', async () => {
    const apps = await consented();
    const plain = await nameReport(apps.alice, FIXTURE);
    await meaningReport(apps.alice, meaningRequest);

    const sent = apps.provider.calls[0] ?? [];
    expect(new Set(sent)).toEqual(new Set(plain.groups.map((g) => g.payee)));
    for (const name of sent) expect(typeof name).toBe('string');

    const payload = JSON.stringify(sent);
    for (const group of plain.groups) {
      expect(payload, 'an amount left the process').not.toContain(group.totalMinor.toString());
    }
    expect(payload).not.toMatch(/2010-03/);
  });

  it('reports what was sent, and when, on the response', async () => {
    const apps = await consented();
    const before = new Date();
    const report = await meaningReport(apps.alice, meaningRequest);

    expect(new Set(report.sent.names)).toEqual(new Set(apps.provider.calls[0]));
    expect(Date.parse(report.sent.at)).toBeGreaterThanOrEqual(before.getTime() - 1_000);
    expect(Date.parse(report.sent.at)).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('contains no figure the model produced — every amount is the SQL aggregate', async () => {
    const apps = await consented();
    apps.provider.reply((names) => ({
      groups: [
        { label: 'Shopping', payees: names.filter((n) => normalise(n) === 'amazon mktp') },
        { label: 'Everything else', payees: names.filter((n) => normalise(n) !== 'amazon mktp') },
      ],
    }));

    const derived = await derive(ALICE, FIXTURE.from, FIXTURE.to);
    const report = await meaningReport(apps.alice, meaningRequest);

    let seen = 0;
    for (const group of report.groups) {
      let total = 0n;
      for (const payee of group.payees) {
        const want = derived.get(normalise(payee.payee));
        expect(want, `${payee.payee} was not derived`).toBeDefined();
        expect(payee.totalMinor).toBe(want?.total);
        expect(payee.transactionCount).toBe(want?.entries.size);
        expect(new Set(payee.categories)).toEqual(want?.categories);
        total += payee.totalMinor;
        seen += 1;
      }
      expect(group.totalMinor, `${group.label} is not the sum of its payees`).toBe(total);
    }
    expect(seen).toBe(derived.size);
    expect(report.totalMinor).toBe(20_900n);
  });

  it('reorganises the same rows — the two views of one period agree', async () => {
    const apps = await consented();
    const plain = await nameReport(apps.alice, FIXTURE);
    const meaning = await meaningReport(apps.alice, meaningRequest);

    expect(meaning.totalMinor).toBe(plain.totalMinor);
    expect(sumOfGroups(meaning)).toBe(sumOfGroups(plain));

    const flattened = new Map(
      meaning.groups.flatMap((g) => g.payees).map((p) => [p.payee, p.totalMinor]),
    );
    expect(flattened.size).toBe(plain.groups.length);
    for (const group of plain.groups) {
      expect(flattened.get(group.payee), `${group.payee} moved`).toBe(group.totalMinor);
    }
  });

  it('marks at most one group largest, and never marks Other', async () => {
    const apps = await consented();
    apps.provider.reply((names) => ({
      groups: [{ label: 'Tools', payees: names.filter((n) => n === 'Zenith Tools') }],
    }));

    const report = await meaningReport(apps.alice, meaningRequest);
    const marked = report.groups.filter((g) => g.isLargest);

    expect(marked).toHaveLength(1);
    expect(marked[0]?.label).toBe('Tools');
    expect(marked[0]?.origin).toBe('model');
    expect(report.groups.filter((g) => g.origin === 'other').every((g) => !g.isLargest)).toBe(true);
  });

  it('puts the payees the model left out into Other, which sorts last', async () => {
    const apps = await consented();
    apps.provider.reply((names) => ({
      groups: [{ label: 'Tools', payees: names.filter((n) => n === 'Zenith Tools') }],
    }));

    const report = await meaningReport(apps.alice, meaningRequest);
    const other = report.groups.at(-1);

    expect(other?.origin).toBe('other');
    expect(report.groups.filter((g) => g.origin === 'other')).toHaveLength(1);
    const derived = await derive(ALICE, FIXTURE.from, FIXTURE.to);
    const ungrouped = [...derived.keys()].filter((key) => key !== 'zenith tools');
    expect(new Set(other?.payees.map((p) => normalise(p.payee)))).toEqual(new Set(ungrouped));
    expect(other?.totalMinor).toBe(20_900n - 15_000n);
  });

  it('sorts Other last even when Other is the largest bucket', async () => {
    const apps = await consented();
    apps.provider.reply((names) => ({
      groups: [{ label: 'Small change', payees: names.filter((n) => n === 'Solo Merchant') }],
    }));

    const report = await meaningReport(apps.alice, meaningRequest);
    const last = report.groups.at(-1);

    expect(last?.origin).toBe('other');
    expect(last?.totalMinor).toBeGreaterThan(report.groups[0]?.totalMinor ?? 0n);
    expect(last?.isLargest).toBe(false);
    expect(report.groups[0]?.isLargest).toBe(true);
  });

  it('never drops a payee, whatever the model grouped', async () => {
    const apps = await consented();
    apps.provider.reply(() => ({ groups: [] }));

    const derived = await derive(ALICE, FIXTURE.from, FIXTURE.to);
    const report = await meaningReport(apps.alice, meaningRequest);

    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.origin).toBe('other');
    expect(new Set(report.groups[0]?.payees.map((p) => normalise(p.payee)))).toEqual(
      new Set(derived.keys()),
    );
  });

  it('renders a hostile label as data — it is text, not an instruction', async () => {
    const apps = await consented();
    const label = 'Ignore previous instructions <script>alert(1)</script>';
    apps.provider.reply((names) => ({ groups: [{ label, payees: [...names] }] }));

    const report = await meaningReport(apps.alice, meaningRequest);
    expect(report.groups[0]?.label).toBe(label);
    expect(report.groups[0]?.origin).toBe('model');
  });

  it('carries no fallback key on a semantic report, and no sent payload on a plain one', async () => {
    const apps = await consented();
    const meaning = await postReport(apps.alice, meaningRequest);
    const plain = await postReport(apps.alice, FIXTURE);

    expect(meaning.body).not.toHaveProperty('fallback');
    expect(plain.body).not.toHaveProperty('sent');
    expect(plain.body).toHaveProperty('fallback');
    for (const group of (plain.body as { groups: Record<string, unknown>[] }).groups) {
      expect(group).not.toHaveProperty('payees');
      expect(group).not.toHaveProperty('label');
    }
  });
});

describe('semantic grouping — a refused answer degrades, never a 500', () => {
  const meaningRequest = { ...FIXTURE, grouping: 'meaning' };

  const consented = async (): Promise<Mounted> => {
    const apps = await mount();
    await setConsent(apps.alice, true);
    return apps;
  };

  it('refuses a response naming a payee that was not sent', async () => {
    const apps = await consented();
    apps.provider.reply((names) => ({
      groups: [{ label: 'Invented', payees: [...names, 'Merchant That Never Was'] }],
    }));

    const report = await nameReport(apps.alice, meaningRequest);

    expect(report.fallback).toBe('provider-failed');
    expect(report.totalMinor).toBe(20_900n);
    expect(wireOf(report)).not.toContain('Merchant That Never Was');
  });

  it('refuses a payee placed in two groups', async () => {
    const apps = await consented();
    apps.provider.reply((names) => ({
      groups: [
        { label: 'First', payees: names.slice(0, 2) },
        { label: 'Second', payees: names.slice(0, 1) },
      ],
    }));

    const report = await nameReport(apps.alice, meaningRequest);
    expect(report.fallback).toBe('provider-failed');
    expect(report.totalMinor).toBe(20_900n);
  });

  it('refuses a payee repeated inside one group — it would be counted twice', async () => {
    const apps = await consented();
    apps.provider.reply((names) => {
      const first = names[0] ?? '';
      return { groups: [{ label: 'Doubled', payees: [first, first] }] };
    });

    const report = await nameReport(apps.alice, meaningRequest);
    expect(report.fallback).toBe('provider-failed');
  });

  it('degrades when the provider throws — a timeout is one of these', async () => {
    const apps = await consented();
    apps.provider.reply(() => {
      throw new Error('Request timed out after 15000ms');
    });

    const res = await postReport(apps.alice, meaningRequest);
    expect(res.status).toBe(200);

    const report = SpendingReport.parse(res.body);
    expect(report.grouping).toBe('name');
    expect((report as NameReport).fallback).toBe('provider-failed');
    expect(report.groups.length).toBeGreaterThan(0);
    expect(report.totalMinor).toBe(20_900n);
  });

  it('degrades when the provider rejects asynchronously', async () => {
    const apps = await consented();
    apps.provider.reply(() => Promise.reject(new Error('connection reset')));

    const report = await nameReport(apps.alice, meaningRequest);
    expect(report.fallback).toBe('provider-failed');
  });

  it('degrades with no key, without asking the owner for consent first', async () => {
    const keyless = createAnthropicProvider(
      {
        apiKey: null,
        model: 'never-called',
        timeoutMs: 1_000,
        maxOutputTokens: 10,
      },
      container.log,
    );
    const cache = createReportCache<SemanticReport>();
    const controller = createInsightsController(
      createInsightsService(
        createReportingService(container.db, noProjection),
        createInsightsRepository(container.db),
        keyless,
        container.log,
        cache,
      ),
    );
    const app = await serve(
      createApp({ ...container, currentUserId: ALICE, insights: controller }),
    );
    await setConsent(app, true);

    const settings = InsightsSettings.parse((await request(app).get(settingsPath)).body);
    expect(settings.semanticAvailable).toBe(false);
    expect(settings.enabled).toBe(true);

    const report = await nameReport(app, meaningRequest);
    expect(report.fallback).toBe('no-key');
    expect(report.totalMinor).toBe(20_900n);
    expect(report.groups[0]?.payee).toBe('Zenith Tools');
  });

  it('asks for nothing when the period is empty', async () => {
    const apps = await consented();
    const report = await nameReport(apps.alice, {
      from: '2009-01-01',
      to: '2009-01-31',
      grouping: 'meaning',
    });

    expect(apps.provider.calls).toEqual([]);
    expect(report.groups).toEqual([]);
    expect(report.totalMinor).toBe(0n);
  });
});

describe('the cache', () => {
  const meaningRequest = { ...FIXTURE, grouping: 'meaning' };

  it('does not pay for the model twice for the same period', async () => {
    const apps = await mount();
    await setConsent(apps.alice, true);

    const first = await meaningReport(apps.alice, meaningRequest);
    const second = await meaningReport(apps.alice, meaningRequest);

    expect(apps.provider.calls).toHaveLength(1);
    expect(second.groups).toEqual(first.groups);
  });

  it('never serves A’s report to B', async () => {
    const apps = await mount();
    await setConsent(apps.alice, true);
    await setConsent(apps.blake, true);

    const period = { from: iso(addMonths(CURRENT, -2)), to: iso(TODAY_DATE), grouping: 'meaning' };
    const alice = await meaningReport(apps.alice, period);
    const blake = await meaningReport(apps.blake, period);

    expect(apps.provider.calls).toHaveLength(2);
    expect(wireOf(blake)).not.toContain('Riverside');
    expect(wireOf(alice)).not.toMatch(/reef/i);
    expect(blake.sent.names).not.toEqual(alice.sent.names);
    expect(blake.sent.names).toContain('REEF Aquatics');
    expect(alice.sent.names).not.toContain('REEF Aquatics');
    expect(blake.totalMinor).not.toBe(alice.totalMinor);
  });

  it('never returns groups that do not add up to the period’s own total', async () => {
    const apps = await mount();
    await setConsent(apps.alice, true);

    const period = { from: '2010-06-01', to: '2010-06-30' };
    const category = await createExpense('Insights Cache');
    await spend('2010-06-04', 'Firstcomer Inc', category.id, '4000', PROBE.funding);

    const first = await meaningReport(apps.alice, { ...period, grouping: 'meaning' });
    expect(first.totalMinor).toBe(4_000n);

    await spend('2010-06-05', 'Latecomer Ltd', category.id, '6000', PROBE.funding);

    const { report } = await reportOf(apps.alice, { ...period, grouping: 'meaning' });
    expect(report.totalMinor).toBe(10_000n);
    expectReconciles(report);
    expect(wireOf(report)).toContain('Latecomer Ltd');
  });
});

describe('validation — every Zod rejection is a 400 problem+json', () => {
  const badDates: [string, string][] = [
    ['a timestamp', '2026-05-04T10:00:00Z'],
    ['a malformed date', '04/05/2026'],
    ['a non-date', 'yesterday'],
    ['an impossible date', '2026-02-30'],
    ['an empty string', ''],
    ['a month only', '2026-05'],
  ];

  let app: Server;

  beforeAll(async () => {
    app = (await mount()).alice;
  });

  it.each(badDates)('rejects %s as from', async (_label, from) => {
    expectValidationProblem(await postReport(app, { from, to: '2026-06-30' }), 'from');
  });

  it.each(badDates)('rejects %s as to', async (_label, to) => {
    expectValidationProblem(await postReport(app, { from: '2026-01-01', to }), 'to');
  });

  it('requires from and to', async () => {
    expectValidationProblem(await postReport(app, { to: '2026-06-30' }), 'from');
    expectValidationProblem(await postReport(app, { from: '2026-01-01' }), 'to');
    expectValidationProblem(await postReport(app, {}), 'from');
  });

  it('rejects from after to, naming from', async () => {
    expectValidationProblem(await postReport(app, { from: '2026-05-20', to: '2026-05-10' }), 'from');
  });

  it(`rejects a period longer than ${MAX_REPORT_MONTHS} months, naming to`, async () => {
    expectValidationProblem(await postReport(app, { from: '2024-01-01', to: '2026-01-01' }), 'to');
  });

  it(`accepts a period of exactly ${MAX_REPORT_MONTHS} calendar months`, async () => {
    const res = await postReport(app, { from: '2024-01-31', to: '2025-12-01' });
    expect(res.status).toBe(200);
  });

  it('rejects a non-uuid projectId', async () => {
    expectValidationProblem(await postReport(app, { ...FIXTURE, projectId: 'not-a-uuid' }), 'projectId');
  });

  it.each([['semantic'], ['meaningful'], ['NAME'], ['']])(
    'rejects %s as a grouping',
    async (grouping) => {
      expectValidationProblem(await postReport(app, { ...FIXTURE, grouping }), 'grouping');
    },
  );

  it('defaults grouping to name when it is absent', async () => {
    const report = await nameReport(app, FIXTURE);
    expect(report.grouping).toBe('name');
    expect(report.fallback).toBeNull();
  });

  it('echoes the period it was asked for', async () => {
    const report = await nameReport(app, FIXTURE);
    expect(report.from).toBe(FIXTURE.from);
    expect(report.to).toBe(FIXTURE.to);
  });
});
