import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountBalanceResponse,
  MAX_BACKDATED_DAYS,
  MAX_PROJECTION_MONTHS,
  OccurrencePaidProblem,
  PayOccurrenceResponse,
  ProjectionResponse,
  RecurringSeries,
  TransactionPage,
  apiPath,
  routes,
  type ScheduledOccurrenceView,
} from '@pfm/contracts';
import { addDays, addMonths, todayUtc } from '../../../prisma/seed/time.js';
import {
  ALICE,
  ALICE_ACCOUNTS,
  BLAKE,
  BLAKE_ACCOUNTS,
  startHarness,
  uniqueName,
  type Harness,
} from '../../test/harness.js';
import { expectProblem, expectValidationProblem } from '../../test/problem.js';

// US4 — "store future bills and income". The write side: the four rules, the
// bounds on how far a schedule may reach in either direction, and the link that
// turns a scheduled occurrence into a transaction exactly once.
//
// Expansion is asserted against the `scheduled_occurrences` rows themselves, so
// the assertions hold whatever horizon a later request asks for. Every money
// figure is a BigInt literal or a before/after delta; none passes through a JS
// `number`.

const recurring = apiPath(routes.recurring);
const pay = (id: string): string => apiPath(routes.occurrencePay(id));
const projection = apiPath(routes.projection);
const entries = apiPath(routes.entries);
const balance = (id: string): string => apiPath(routes.accountBalance(id));
const entryPath = (id: string): string => apiPath(routes.entry(id));

const iso = (value: Date): string => value.toISOString().slice(0, 10);
const asDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

const TODAY_DATE = todayUtc();
const TODAY = iso(TODAY_DATE);
const inDays = (days: number): string => iso(addDays(TODAY_DATE, days));
const inMonths = (months: number): string => iso(addMonths(TODAY_DATE, months));

const NOBODY = '00000000-0000-4000-8000-0000000000ef';

/**
 * The contract's clamp, written out: a day past the end of a shorter month
 * lands on that month's last day, and the month after recovers the anchor day.
 */
const monthlyDue = (from: string, day: number, count: number): string[] => {
  const year = Number(from.slice(0, 4));
  const month = Number(from.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_unused, i) => {
    const last = new Date(Date.UTC(year, month + i + 1, 0)).getUTCDate();
    return iso(new Date(Date.UTC(year, month + i, Math.min(day, last))));
  });
};

/** The first 31st after today — a monthly-on-the-31st series has to start on one. */
const firstThirtyFirst = (): string => {
  for (let i = 0; i < 24; i += 1) {
    const month = new Date(
      Date.UTC(TODAY_DATE.getUTCFullYear(), TODAY_DATE.getUTCMonth() + i, 1),
    );
    const last = new Date(
      Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0),
    ).getUTCDate();
    if (last !== 31) continue;
    const candidate = iso(
      new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 31)),
    );
    if (candidate > TODAY) return candidate;
  }
  throw new Error('no 31st within two years — impossible');
};

let h: Harness;

const getProjection = async (
  to: string,
  app: Server = h.app,
): Promise<ProjectionResponse> => {
  const res = await request(app).get(projection).query({ to });
  expect(res.status).toBe(200);
  return ProjectionResponse.parse(res.body);
};

type SeriesBody = Record<string, unknown>;

const bill = (overrides: SeriesBody = {}): SeriesBody => ({
  payee: uniqueName('Bill'),
  amountMinor: '-5000',
  ledgerAccountId: ALICE_ACCOUNTS.checking,
  categoryId: ALICE_ACCOUNTS.household,
  rule: { frequency: 'one-off' },
  firstDueOn: inDays(4),
  ...overrides,
});

const createSeries = async (
  body: SeriesBody,
  app: Server = h.app,
): Promise<RecurringSeries> => {
  const res = await request(app).post(recurring).send(body);
  expect([200, 201]).toContain(res.status);
  return RecurringSeries.parse(res.body);
};

const dueDatesOf = async (seriesId: string): Promise<string[]> => {
  const rows = await h.db.scheduledOccurrence.findMany({
    where: { seriesId },
    orderBy: { dueOn: 'asc' },
  });
  return rows.map((row) => iso(row.dueOn));
};

/** Occurrences only exist once something asks for a horizon that reaches them. */
const expandThrough = async (to: string): Promise<ProjectionResponse> =>
  getProjection(to);

const occurrenceIdOf = async (
  seriesId: string,
  dueOn: string,
): Promise<string> => {
  const row = await h.db.scheduledOccurrence.findFirstOrThrow({
    where: { seriesId, dueOn: asDate(dueOn) },
  });
  return row.id;
};

const seriesCount = async (ownerId: string): Promise<number> =>
  h.db.recurringSeries.count({ where: { ownerId } });

/** The raw signed sum over asset and liability lines — `netWorthMinor`'s basis. */
const ledgerNetThrough = async (to: string): Promise<bigint> => {
  const lines = await h.db.entryLine.findMany({
    where: {
      entry: { ownerId: ALICE, occurredOn: { lte: asDate(to) } },
      ledgerAccount: { kind: { in: ['asset', 'liability'] } },
    },
    select: { amountMinor: true },
  });
  return lines.reduce((total, line) => total + line.amountMinor, 0n);
};

const payOccurrence = async (
  occurrenceId: string,
  body: Record<string, unknown>,
): Promise<PayOccurrenceResponse> => {
  const res = await request(h.app).post(pay(occurrenceId)).send(body);
  expect([200, 201]).toContain(res.status);
  return PayOccurrenceResponse.parse(res.body);
};

const expectRuleRejected = (res: Response): void => {
  const problem = expectValidationProblem(res);
  expect(
    problem.errors?.some(
      (issue) => issue.path === 'rule' || issue.path.startsWith('rule.'),
    ),
  ).toBe(true);
};

/** Another owner's id answers exactly as an id that does not exist. */
const expectIndistinguishable = (foreign: Response, absent: Response): void => {
  expect(foreign.status).toBe(absent.status);
  expect(foreign.status).toBeGreaterThanOrEqual(400);
  expect(foreign.status).toBeLessThan(500);
  expect(foreign.status).not.toBe(403);

  const problem = expectProblem(foreign, foreign.status);
  expect(problem.type).toBe(expectProblem(absent, absent.status).type);
  expect(JSON.stringify(problem)).not.toContain('Reef');
  expect(JSON.stringify(problem)).not.toContain('REEF');
};

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

// ---------------------------------------------------------------------------

describe('POST /recurring', () => {
  it('stores a bill and echoes it back as the contract describes it', async () => {
    const body = bill({
      payee: '  Northlink Fibre  ',
      amountMinor: '-7250',
      firstDueOn: inDays(6),
      endsOn: null,
    });

    const created = await createSeries(body);

    expect(created.payee).toBe('Northlink Fibre');
    expect(created.amountMinor).toBe(-7_250n);
    expect(created.ledgerAccountId).toBe(ALICE_ACCOUNTS.checking);
    expect(created.categoryId).toBe(ALICE_ACCOUNTS.household);
    expect(created.rule).toEqual({ frequency: 'one-off' });
    expect(created.firstDueOn).toBe(inDays(6));
    expect(created.endsOn).toBeNull();

    const row = await h.db.recurringSeries.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.ownerId).toBe(ALICE);
    expect(row.amountMinor).toBe(-7_250n);
  });

  it('carries the amount as a string on the wire', async () => {
    const res = await request(h.app).post(recurring).send(bill());
    expect(typeof (res.body as Record<string, unknown>)['amountMinor']).toBe(
      'string',
    );
  });

  it('puts a new series’ first occurrence in the projection immediately', async () => {
    const to = inDays(10);
    const before = await getProjection(to);
    const created = await createSeries(
      bill({
        payee: uniqueName('Immediate'),
        amountMinor: '-12345',
        firstDueOn: inDays(2),
      }),
    );

    const after = await getProjection(to);
    const mine = after.scheduled.occurrences.filter(
      (row) => row.seriesId === created.id,
    );

    expect(mine).toHaveLength(1);
    const first = mine[0] as ScheduledOccurrenceView;
    expect(first.dueOn).toBe(inDays(2));
    expect(first.amountMinor).toBe(-12_345n);
    expect(first.payee).toBe(created.payee);
    expect(first.ledgerAccountName).toBe('Everyday Checking');
    expect(first.categoryName).toBe('Household');
    expect(after.scheduled.netMinor).toBe(before.scheduled.netMinor - 12_345n);
    expect(after.projectedNetWorthMinor).toBe(
      before.projectedNetWorthMinor - 12_345n,
    );
    expect(after.netWorthMinor).toBe(before.netWorthMinor);
  });

  it('accepts income, positive in the same net-worth basis', async () => {
    const created = await createSeries(
      bill({
        payee: uniqueName('Stipend'),
        amountMinor: '180000',
        categoryId: ALICE_ACCOUNTS.salary,
        firstDueOn: inDays(3),
      }),
    );
    expect(created.amountMinor).toBe(180_000n);

    const body = await expandThrough(inDays(5));
    const row = body.scheduled.occurrences.find(
      (o) => o.seriesId === created.id,
    );
    expect(row?.amountMinor).toBe(180_000n);
  });

  it('accepts a charge on a credit card, negative because more is owed', async () => {
    const created = await createSeries(
      bill({
        payee: uniqueName('Gym'),
        amountMinor: '-3500',
        ledgerAccountId: ALICE_ACCOUNTS.visa,
        firstDueOn: inDays(3),
      }),
    );
    expect(created.amountMinor).toBe(-3_500n);

    const body = await expandThrough(inDays(5));
    const row = body.scheduled.occurrences.find(
      (o) => o.seriesId === created.id,
    );
    expect(row?.amountMinor).toBe(-3_500n);
    expect(row?.ledgerAccountName).toBe('Visa Credit Card');
  });
});

describe('the four rules expand, and nothing else does', () => {
  it('expands a one-off to exactly one occurrence, however far the horizon reaches', async () => {
    const created = await createSeries(
      bill({ payee: uniqueName('One-off'), firstDueOn: inDays(9) }),
    );

    await expandThrough(inMonths(MAX_PROJECTION_MONTHS));
    expect(await dueDatesOf(created.id)).toEqual([inDays(9)]);
  });

  it('expands weekly every seven days, up to and including endsOn', async () => {
    const created = await createSeries(
      bill({
        payee: uniqueName('Weekly'),
        rule: { frequency: 'weekly' },
        firstDueOn: inDays(1),
        endsOn: inDays(29),
      }),
    );

    await expandThrough(inDays(40));
    expect(await dueDatesOf(created.id)).toEqual([
      inDays(1),
      inDays(8),
      inDays(15),
      inDays(22),
      inDays(29),
    ]);
  });

  it('expands biweekly every fourteen days, and stops short of an endsOn between two', async () => {
    const created = await createSeries(
      bill({
        payee: uniqueName('Biweekly'),
        rule: { frequency: 'biweekly' },
        firstDueOn: inDays(2),
        endsOn: inDays(40),
      }),
    );

    await expandThrough(inDays(60));
    expect(await dueDatesOf(created.id)).toEqual([
      inDays(2),
      inDays(16),
      inDays(30),
    ]);
  });

  it('expands monthly on its anchor day', async () => {
    // The next 15th: an anchor that exists in every month, so this test is the
    // plain case and the clamp is the next test's subject alone.
    const due = monthlyDue(`${TODAY.slice(0, 7)}-15`, 15, 6).filter(
      (day) => day > TODAY,
    );
    const expected = due.slice(0, 4);
    const created = await createSeries(
      bill({
        payee: uniqueName('Monthly'),
        rule: { frequency: 'monthly', dayOfMonth: 15 },
        firstDueOn: expected[0],
        endsOn: expected.at(-1),
      }),
    );

    await expandThrough(inMonths(6));
    expect(await dueDatesOf(created.id)).toEqual(expected);
  });

  it('expands monthly-on-the-31st through the clamp, and keeps reading as the 31st', async () => {
    // Three months from the next 31st: always inside the horizon, and at least
    // one of any three consecutive months is short, so the clamp is exercised
    // whatever today is. February itself, and the recovery after it, are pinned
    // against the recurrence directly in `rules.test.ts` — the horizon cannot
    // reach next February and the March after it for part of the year.
    const due = monthlyDue(firstThirtyFirst(), 31, 3);
    const created = await createSeries(
      bill({
        payee: uniqueName('Thirty-first'),
        rule: { frequency: 'monthly', dayOfMonth: 31 },
        firstDueOn: due[0],
        endsOn: due.at(-1),
      }),
    );

    await expandThrough(due.at(-1) as string);
    expect(await dueDatesOf(created.id)).toEqual(due);
    expect(due.some((day) => day.slice(8, 10) !== '31')).toBe(true);

    // The rule still reads "the 31st" in the month it fell short of it.
    expect(created.rule).toEqual({ frequency: 'monthly', dayOfMonth: 31 });
    expect(
      (
        await h.db.recurringSeries.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).dayOfMonth,
    ).toBe(31);
  });

  it('expands a series that ends on its first due date to exactly that one day', async () => {
    const created = await createSeries(
      bill({
        payee: uniqueName('Single day'),
        rule: { frequency: 'weekly' },
        firstDueOn: inDays(7),
        endsOn: inDays(7),
      }),
    );

    await expandThrough(inDays(60));
    expect(await dueDatesOf(created.id)).toEqual([inDays(7)]);
  });

  it('is idempotent — the same horizon twice is the same rows, and a shorter one loses none', async () => {
    const created = await createSeries(
      bill({
        payee: uniqueName('Idempotent'),
        rule: { frequency: 'weekly' },
        firstDueOn: inDays(1),
        endsOn: inDays(57),
      }),
    );

    await expandThrough(inDays(30));
    const first = await h.db.scheduledOccurrence.findMany({
      where: { seriesId: created.id },
      orderBy: { dueOn: 'asc' },
    });

    await expandThrough(inDays(30));
    const second = await h.db.scheduledOccurrence.findMany({
      where: { seriesId: created.id },
      orderBy: { dueOn: 'asc' },
    });
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(second.map((row) => iso(row.dueOn))).toEqual(
      first.map((row) => iso(row.dueOn)),
    );

    // A shorter horizon deletes nothing, and a longer one only adds.
    await expandThrough(inDays(2));
    expect((await dueDatesOf(created.id)).length).toBe(first.length);

    await expandThrough(inDays(60));
    const grown = await dueDatesOf(created.id);
    expect(grown.slice(0, first.length)).toEqual(
      first.map((row) => iso(row.dueOn)),
    );
    expect(new Set(grown).size).toBe(grown.length);
    expect(grown.at(-1)).toBe(inDays(57));

    await expandThrough(inDays(60));
    expect(await dueDatesOf(created.id)).toEqual(grown);
  });
});

describe('POST /recurring — the rule union admits four shapes and no more', () => {
  const rejected: [string, unknown][] = [
    ['a fifth frequency', { frequency: 'daily' }],
    ['a quarterly frequency', { frequency: 'quarterly' }],
    ['the storage spelling of one-off', { frequency: 'oneOff' }],
    ['a missing frequency', {}],
    ['a generic interval', { frequency: 'weekly', interval: 2 }],
    ['a day of month on a weekly rule', { frequency: 'weekly', dayOfMonth: 5 }],
    ['a day of month on a one-off', { frequency: 'one-off', dayOfMonth: 5 }],
    [
      'an RRULE',
      { frequency: 'monthly', dayOfMonth: 5, rrule: 'FREQ=MONTHLY' },
    ],
    ['monthly with no day of month', { frequency: 'monthly' }],
    ['a zeroth day of the month', { frequency: 'monthly', dayOfMonth: 0 }],
    ['a thirty-second day', { frequency: 'monthly', dayOfMonth: 32 }],
    ['a fractional day', { frequency: 'monthly', dayOfMonth: 1.5 }],
    ['a day of month as a string', { frequency: 'monthly', dayOfMonth: '5' }],
    ['a rule that is a string', 'weekly'],
    ['a null rule', null],
  ];

  it.each(rejected)('rejects %s and stores nothing', async (_label, rule) => {
    const before = await seriesCount(ALICE);
    expectRuleRejected(
      await request(h.app)
        .post(recurring)
        .send(bill({ rule, firstDueOn: inDays(3) })),
    );
    expect(await seriesCount(ALICE)).toBe(before);
  });

  it('rejects a missing rule', async () => {
    const body = bill();
    delete body['rule'];
    expectValidationProblem(
      await request(h.app).post(recurring).send(body),
      'rule',
    );
  });

  it('accepts each of the four, and only writes what it was given', async () => {
    const shapes = [
      { frequency: 'one-off' },
      { frequency: 'weekly' },
      { frequency: 'biweekly' },
      { frequency: 'monthly', dayOfMonth: Number(inDays(3).slice(8, 10)) },
    ] as const;

    for (const rule of shapes) {
      const created = await createSeries(
        bill({
          payee: uniqueName('Shape'),
          rule,
          firstDueOn: inDays(3),
          endsOn: inDays(3),
        }),
      );
      expect(created.rule).toEqual(rule);
      const row = await h.db.recurringSeries.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.dayOfMonth).toBe(
        rule.frequency === 'monthly' ? rule.dayOfMonth : null,
      );
    }
  });
});

describe('POST /recurring — the rest of the validation', () => {
  const cases: [string, SeriesBody, string][] = [
    ['an empty payee', { payee: '' }, 'payee'],
    ['a whitespace payee', { payee: '   ' }, 'payee'],
    ['a payee over 120 characters', { payee: 'x'.repeat(121) }, 'payee'],
    ['a numeric payee', { payee: 42 }, 'payee'],
    ['a zero amount', { amountMinor: '0' }, 'amountMinor'],
    ['an amount as a JSON number', { amountMinor: -5000 }, 'amountMinor'],
    ['a fractional amount', { amountMinor: '-50.00' }, 'amountMinor'],
    ['an empty amount', { amountMinor: '' }, 'amountMinor'],
    ['a non-uuid account', { ledgerAccountId: 'checking' }, 'ledgerAccountId'],
    ['a non-uuid category', { categoryId: 'household' }, 'categoryId'],
    [
      'a first due date that is not a date',
      { firstDueOn: 'tomorrow' },
      'firstDueOn',
    ],
    [
      'an impossible first due date',
      { firstDueOn: '2027-02-30' },
      'firstDueOn',
    ],
    [
      'a first due timestamp',
      { firstDueOn: '2027-02-01T00:00:00Z' },
      'firstDueOn',
    ],
    ['an endsOn that is not a date', { endsOn: 'never' }, 'endsOn'],
  ];

  it.each(cases)(
    'rejects %s, naming it, and stores nothing',
    async (_label, patch, path) => {
      const before = await seriesCount(ALICE);
      expectValidationProblem(
        await request(h.app).post(recurring).send(bill(patch)),
        path,
      );
      expect(await seriesCount(ALICE)).toBe(before);
    },
  );

  it('rejects an endsOn before the first due date, naming endsOn', async () => {
    expectValidationProblem(
      await request(h.app)
        .post(recurring)
        .send(bill({ firstDueOn: inDays(10), endsOn: inDays(9) })),
      'endsOn',
    );
  });

  it('accepts an endsOn equal to the first due date', async () => {
    const created = await createSeries(
      bill({ firstDueOn: inDays(10), endsOn: inDays(10) }),
    );
    expect(created.endsOn).toBe(inDays(10));
  });

  it('defaults a missing endsOn to null — until further notice', async () => {
    const body = bill();
    delete body['endsOn'];
    expect((await createSeries(body)).endsOn).toBeNull();
  });

  it('rejects a monthly first due date that is not on the rule’s day', async () => {
    const day = Number(inDays(5).slice(8, 10));
    expectValidationProblem(
      await request(h.app)
        .post(recurring)
        .send(
          bill({
            rule: { frequency: 'monthly', dayOfMonth: day === 28 ? 27 : 28 },
            firstDueOn: inDays(5),
          }),
        ),
      'firstDueOn',
    );
  });

  it('accepts a monthly 31st anchored to a shorter month’s last day', async () => {
    // September has 30 days: the same clamp expansion applies, checked at creation.
    const created = await createSeries(
      bill({
        payee: uniqueName('Clamped anchor'),
        rule: { frequency: 'monthly', dayOfMonth: 31 },
        firstDueOn: '2027-09-30',
        endsOn: '2027-09-30',
      }),
    );
    expect(created.rule).toEqual({ frequency: 'monthly', dayOfMonth: 31 });
    expect(created.firstDueOn).toBe('2027-09-30');
  });

  it('refuses an account that is a category, and a category that is an account', async () => {
    const before = await seriesCount(ALICE);

    for (const patch of [
      { ledgerAccountId: ALICE_ACCOUNTS.groceries },
      { ledgerAccountId: ALICE_ACCOUNTS.salary },
      { categoryId: ALICE_ACCOUNTS.checking },
      { categoryId: ALICE_ACCOUNTS.visa },
      { categoryId: ALICE_ACCOUNTS.openingBalances },
    ]) {
      const res = await request(h.app).post(recurring).send(bill(patch));
      // Well-formed, but it names the wrong side of the chart: 422, not 400.
      expectProblem(res, 422);
    }

    expect(await seriesCount(ALICE)).toBe(before);
  });

  it('refuses an account that does not exist', async () => {
    const before = await seriesCount(ALICE);
    const res = await request(h.app)
      .post(recurring)
      .send(bill({ ledgerAccountId: NOBODY }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await seriesCount(ALICE)).toBe(before);
  });
});

describe(`a schedule reaches at most ${MAX_BACKDATED_DAYS} days back`, () => {
  it('accepts a first due date exactly at the limit, and expands it as overdue', async () => {
    const at = inDays(-MAX_BACKDATED_DAYS);
    const created = await createSeries(
      bill({
        payee: uniqueName('At the limit'),
        firstDueOn: at,
        amountMinor: '-999',
      }),
    );

    expect(created.firstDueOn).toBe(at);

    const body = await expandThrough(inDays(7));
    expect(await dueDatesOf(created.id)).toEqual([at]);
    expect(
      body.overdue.occurrences.some((row) => row.seriesId === created.id),
    ).toBe(true);
    expect(
      body.scheduled.occurrences.some((row) => row.seriesId === created.id),
    ).toBe(false);
  });

  it('refuses one day further back, naming the limit and the boundary date, and writes nothing', async () => {
    const before = await seriesCount(ALICE);
    const earliest = inDays(-MAX_BACKDATED_DAYS);

    const res = await request(h.app)
      .post(recurring)
      .send(bill({ firstDueOn: inDays(-MAX_BACKDATED_DAYS - 1) }));

    // A perfectly good calendar date breaking a rule about what a schedule is:
    // 422, the class this endpoint already answers for an account of the wrong
    // kind — not the 400 the projection horizon answers for a query parameter
    // outside its range.
    const problem = expectProblem(res, 422);
    const said = `${problem.title} ${problem.detail ?? ''}`;
    expect(said).toContain(String(MAX_BACKDATED_DAYS));
    expect(said).toContain(earliest);

    expect(await seriesCount(ALICE)).toBe(before);
  });

  it('answers it differently from an out-of-range horizon, which is a 400 on a parameter', async () => {
    const backdated = await request(h.app)
      .post(recurring)
      .send(bill({ firstDueOn: inDays(-MAX_BACKDATED_DAYS - 1) }));
    const beyondHorizon = await request(h.app)
      .get(projection)
      .query({ to: iso(addDays(asDate(inMonths(MAX_PROJECTION_MONTHS)), 1)) });

    expect(backdated.status).toBe(422);
    expect(beyondHorizon.status).toBe(400);
    // The 422 is not a validation problem, so it carries no field errors.
    expect(expectProblem(backdated, 422).errors).toBeUndefined();
  });
});

describe('tenancy — a schedule may not reach into the other tenant’s ledger', () => {
  it('refuses a series posted against the decoy’s account, exactly as it refuses an absent one', async () => {
    const before = await seriesCount(ALICE);

    expectIndistinguishable(
      await request(h.app)
        .post(recurring)
        .send(bill({ ledgerAccountId: BLAKE_ACCOUNTS.checking })),
      await request(h.app)
        .post(recurring)
        .send(bill({ ledgerAccountId: NOBODY })),
    );

    expect(await seriesCount(ALICE)).toBe(before);
    expect(
      await h.db.recurringSeries.count({
        where: { ledgerAccountId: BLAKE_ACCOUNTS.checking, ownerId: ALICE },
      }),
    ).toBe(0);
  });

  it('refuses a series posted against the decoy’s category', async () => {
    const before = await seriesCount(ALICE);

    expectIndistinguishable(
      await request(h.app)
        .post(recurring)
        .send(bill({ categoryId: BLAKE_ACCOUNTS.spending })),
      await request(h.app)
        .post(recurring)
        .send(bill({ categoryId: NOBODY })),
    );

    expect(await seriesCount(ALICE)).toBe(before);
  });

  it('keeps one tenant’s new series out of the other’s projection', async () => {
    const asBlake = await h.as(BLAKE);
    const to = inDays(12);
    const mine = await createSeries(
      bill({ payee: uniqueName('Mine only'), firstDueOn: inDays(5) }),
    );
    const theirs = await createSeries(
      bill({
        payee: uniqueName('Theirs only'),
        ledgerAccountId: BLAKE_ACCOUNTS.checking,
        categoryId: BLAKE_ACCOUNTS.spending,
        firstDueOn: inDays(5),
      }),
      asBlake,
    );

    const ours = await getProjection(to);
    const others = await getProjection(to, asBlake);

    expect(ours.scheduled.occurrences.map((row) => row.seriesId)).toContain(
      mine.id,
    );
    expect(ours.scheduled.occurrences.map((row) => row.seriesId)).not.toContain(
      theirs.id,
    );
    expect(others.scheduled.occurrences.map((row) => row.seriesId)).toContain(
      theirs.id,
    );
    expect(
      others.scheduled.occurrences.map((row) => row.seriesId),
    ).not.toContain(mine.id);

    // And expanding for one owner wrote nothing under the other's series.
    expect(
      await h.db.scheduledOccurrence.count({
        where: { seriesId: mine.id, series: { ownerId: BLAKE } },
      }),
    ).toBe(0);
    expect(
      await h.db.scheduledOccurrence.count({
        where: { seriesId: theirs.id, series: { ownerId: ALICE } },
      }),
    ).toBe(0);
  });
});

describe('POST /occurrences/:id/pay — the link that prevents double counting', () => {
  it('replaces the occurrence with an ordinary entry, exactly once', async () => {
    const to = inMonths(1);
    const created = await createSeries(
      bill({
        payee: uniqueName('Water'),
        amountMinor: '-6420',
        firstDueOn: inDays(5),
      }),
    );
    const before = await expandThrough(to);
    const occurrenceId = await occurrenceIdOf(created.id, inDays(5));

    const res = await request(h.app)
      .post(pay(occurrenceId))
      .send({
        paidOn: inDays(5),
        amountMinor: '-6420',
        ledgerAccountId: ALICE_ACCOUNTS.checking,
      });
    expect([200, 201]).toContain(res.status);
    const paid = PayOccurrenceResponse.parse(res.body);

    expect(paid.occurrence.id).toBe(occurrenceId);
    expect(paid.occurrence.materializedEntryId).toBe(paid.entry.id);
    expect(paid.occurrence.amountMinor).toBe(-6_420n);
    expect(paid.entry.occurredOn).toBe(inDays(5));
    expect(paid.entry.lockedAt).toBeNull();
    expect(paid.entry.reversesEntryId).toBeNull();

    const byAccount = new Map(
      paid.entry.lines.map((line) => [line.ledgerAccountId, line.amountMinor]),
    );
    expect(byAccount.get(ALICE_ACCOUNTS.checking)).toBe(-6_420n);
    expect(byAccount.get(ALICE_ACCOUNTS.household)).toBe(6_420n);
    expect(
      paid.entry.lines.reduce((total, l) => total + l.amountMinor, 0n),
    ).toBe(0n);

    const after = await getProjection(to);
    const ids = [
      ...after.scheduled.occurrences,
      ...after.overdue.occurrences,
    ].map((row) => row.id);
    expect(ids).not.toContain(occurrenceId);

    // The occurrence left the forecast and the entry arrived in it: one figure,
    // two moves, and neither the balance nor the forecast counts the bill twice.
    expect(after.scheduled.netMinor).toBe(before.scheduled.netMinor + 6_420n);
    expect(after.projectedNetWorthMinor).toBe(before.projectedNetWorthMinor);
    expect(after.netWorthMinor).toBe(before.netWorthMinor);

    const register = TransactionPage.parse(
      (
        await request(h.app)
          .get(entries)
          .query({
            accountId: ALICE_ACCOUNTS.checking,
            from: inDays(5),
            to: inDays(5),
            limit: 200,
          })
      ).body,
    );
    expect(register.data.map((row) => row.entryId)).toContain(paid.entry.id);
  });

  it('carries the series’ payee onto the entry it posts', async () => {
    const created = await createSeries(
      bill({ payee: uniqueName('Named payee'), firstDueOn: inDays(6) }),
    );
    await expandThrough(inDays(24));
    const occurrenceId = await occurrenceIdOf(created.id, inDays(6));

    const res = await request(h.app)
      .post(pay(occurrenceId))
      .send({
        paidOn: inDays(6),
        amountMinor: '-5000',
        ledgerAccountId: ALICE_ACCOUNTS.checking,
      });
    expect([200, 201]).toContain(res.status);
    expect(PayOccurrenceResponse.parse(res.body).entry.payee).toBe(
      created.payee,
    );
  });

  it('answers a second payment with a 409 naming the entry that already materialised it', async () => {
    const created = await createSeries(
      bill({ payee: uniqueName('Paid twice'), firstDueOn: inDays(7) }),
    );
    await expandThrough(inDays(24));
    const occurrenceId = await occurrenceIdOf(created.id, inDays(7));
    const request1 = {
      paidOn: inDays(7),
      amountMinor: '-5000',
      ledgerAccountId: ALICE_ACCOUNTS.checking,
    };

    const first = await request(h.app).post(pay(occurrenceId)).send(request1);
    expect([200, 201]).toContain(first.status);
    const entryId = PayOccurrenceResponse.parse(first.body).entry.id;

    const before = await h.db.entry.count({ where: { ownerId: ALICE } });
    const second = await request(h.app).post(pay(occurrenceId)).send(request1);

    expectProblem(second, 409);
    expect(OccurrencePaidProblem.parse(second.body).materializedEntryId).toBe(
      entryId,
    );
    expect(await h.db.entry.count({ where: { ownerId: ALICE } })).toBe(before);
  });

  it('leaves the forecast unchanged when the bill is paid on its date for its amount', async () => {
    const to = inMonths(1);
    const created = await createSeries(
      bill({
        payee: uniqueName('Exact'),
        amountMinor: '-8800',
        firstDueOn: inDays(8),
      }),
    );
    const before = await expandThrough(to);
    const occurrenceId = await occurrenceIdOf(created.id, inDays(8));

    const res = await request(h.app)
      .post(pay(occurrenceId))
      .send({
        paidOn: inDays(8),
        amountMinor: '-8800',
        ledgerAccountId: ALICE_ACCOUNTS.checking,
      });
    expect([200, 201]).toContain(res.status);

    const after = await getProjection(to);
    // The entry is future-dated: outside the balance, inside the forecast.
    expect(after.netWorthMinor).toBe(before.netWorthMinor);
    expect(after.projectedNetWorthMinor).toBe(before.projectedNetWorthMinor);
    expect(after.scheduled.netMinor).toBe(before.scheduled.netMinor + 8_800n);
  });

  it('moves today’s net worth, and only today’s, when the bill is dated today', async () => {
    const to = inMonths(1);
    const created = await createSeries(
      bill({
        payee: uniqueName('Due today'),
        amountMinor: '-7000',
        firstDueOn: TODAY,
      }),
    );
    const before = await expandThrough(to);
    const occurrenceId = await occurrenceIdOf(created.id, TODAY);
    expect(
      before.scheduled.occurrences.some((row) => row.id === occurrenceId),
    ).toBe(true);

    const res = await request(h.app).post(pay(occurrenceId)).send({
      paidOn: TODAY,
      amountMinor: '-7000',
      ledgerAccountId: ALICE_ACCOUNTS.checking,
    });
    expect([200, 201]).toContain(res.status);

    const after = await getProjection(to);
    // Today's balance moves, because the entry is dated today.
    expect(after.netWorthMinor).toBe(before.netWorthMinor - 7_000n);
    // The forecast does not: the occurrence leaving cancels the entry arriving.
    expect(after.projectedNetWorthMinor).toBe(before.projectedNetWorthMinor);
    expect(after.scheduled.netMinor).toBe(before.scheduled.netMinor + 7_000n);
  });

  it('changes the forecast by exactly the difference when the amount differs', async () => {
    const to = inMonths(1);
    const created = await createSeries(
      bill({
        payee: uniqueName('Higher'),
        amountMinor: '-5000',
        firstDueOn: inDays(9),
      }),
    );
    const before = await expandThrough(to);
    const occurrenceId = await occurrenceIdOf(created.id, inDays(9));

    const res = await request(h.app)
      .post(pay(occurrenceId))
      .send({
        paidOn: inDays(9),
        amountMinor: '-6500',
        ledgerAccountId: ALICE_ACCOUNTS.checking,
      });
    expect([200, 201]).toContain(res.status);
    expect(
      PayOccurrenceResponse.parse(res.body)
        .entry.lines.map((l) => l.amountMinor)
        .sort(),
    ).toEqual([-6_500n, 6_500n].sort());

    const after = await getProjection(to);
    expect(after.projectedNetWorthMinor - before.projectedNetWorthMinor).toBe(
      -1_500n,
    );
    expect(after.netWorthMinor).toBe(before.netWorthMinor);
  });

  it('brings an overdue bill into the forecast when it is paid, because it was never in it', async () => {
    const to = inMonths(1);
    const created = await createSeries(
      bill({
        payee: uniqueName('Overdue'),
        amountMinor: '-4321',
        firstDueOn: inDays(-3),
      }),
    );
    const before = await expandThrough(to);
    const occurrenceId = await occurrenceIdOf(created.id, inDays(-3));
    expect(
      before.overdue.occurrences.some((row) => row.id === occurrenceId),
    ).toBe(true);

    const res = await request(h.app).post(pay(occurrenceId)).send({
      paidOn: TODAY,
      amountMinor: '-4321',
      ledgerAccountId: ALICE_ACCOUNTS.checking,
    });
    expect([200, 201]).toContain(res.status);

    const after = await getProjection(to);
    expect(after.overdue.netMinor).toBe(before.overdue.netMinor + 4_321n);
    expect(after.overdue.occurrences.map((row) => row.id)).not.toContain(
      occurrenceId,
    );
    expect(after.netWorthMinor).toBe(before.netWorthMinor - 4_321n);
    // It was excluded from the forecast, so paying it moves the forecast too.
    expect(after.projectedNetWorthMinor).toBe(
      before.projectedNetWorthMinor - 4_321n,
    );
  });

  it('posts to the account the caller names, not the one the series carries', async () => {
    const created = await createSeries(
      bill({
        payee: uniqueName('Other account'),
        amountMinor: '-2500',
        firstDueOn: inDays(10),
      }),
    );
    await expandThrough(inDays(24));
    const occurrenceId = await occurrenceIdOf(created.id, inDays(10));

    const res = await request(h.app)
      .post(pay(occurrenceId))
      .send({
        paidOn: inDays(10),
        amountMinor: '-2500',
        ledgerAccountId: ALICE_ACCOUNTS.savings,
      });
    expect([200, 201]).toContain(res.status);
    const entry = PayOccurrenceResponse.parse(res.body).entry;

    const byAccount = new Map(
      entry.lines.map((line) => [line.ledgerAccountId, line.amountMinor]),
    );
    expect(byAccount.get(ALICE_ACCOUNTS.savings)).toBe(-2_500n);
    expect(byAccount.has(ALICE_ACCOUNTS.checking)).toBe(false);
  });

  it('pays a credit-card bill onto the liability, keeping the sign', async () => {
    const created = await createSeries(
      bill({
        payee: uniqueName('Card charge'),
        amountMinor: '-3500',
        ledgerAccountId: ALICE_ACCOUNTS.visa,
        categoryId: ALICE_ACCOUNTS.household,
        firstDueOn: inDays(5),
      }),
    );
    await expandThrough(inDays(24));
    const occurrenceId = await occurrenceIdOf(created.id, inDays(5));

    const res = await request(h.app).post(pay(occurrenceId)).send({
      paidOn: TODAY,
      amountMinor: '-3500',
      ledgerAccountId: ALICE_ACCOUNTS.visa,
    });
    expect([200, 201]).toContain(res.status);
    const entry = PayOccurrenceResponse.parse(res.body).entry;

    const byAccount = new Map(
      entry.lines.map((line) => [line.ledgerAccountId, line.amountMinor]),
    );
    // Raw storage: more owed on a liability is negative, the expense positive.
    expect(byAccount.get(ALICE_ACCOUNTS.visa)).toBe(-3_500n);
    expect(byAccount.get(ALICE_ACCOUNTS.household)).toBe(3_500n);
  });

  it('pays income, raising the balance and clearing the occurrence', async () => {
    const created = await createSeries(
      bill({
        payee: uniqueName('Payday'),
        amountMinor: '242990',
        categoryId: ALICE_ACCOUNTS.salary,
        firstDueOn: TODAY,
      }),
    );
    await expandThrough(inDays(24));
    const occurrenceId = await occurrenceIdOf(created.id, TODAY);

    const res = await request(h.app).post(pay(occurrenceId)).send({
      paidOn: TODAY,
      amountMinor: '242990',
      ledgerAccountId: ALICE_ACCOUNTS.checking,
    });
    expect([200, 201]).toContain(res.status);
    const entry = PayOccurrenceResponse.parse(res.body).entry;

    const byAccount = new Map(
      entry.lines.map((line) => [line.ledgerAccountId, line.amountMinor]),
    );
    expect(byAccount.get(ALICE_ACCOUNTS.checking)).toBe(242_990n);
    // Income is stored negative; nothing here flips a sign for display.
    expect(byAccount.get(ALICE_ACCOUNTS.salary)).toBe(-242_990n);
  });
});

/**
 * Deleting the entry that paid a bill, through the ordinary entry path.
 *
 * `materializedEntryId` "is the only thing that ever takes it out of the
 * projection — nothing dismisses one", and `scheduled` is defined as the
 * occurrences "that carry no `materializedEntryId`". So membership turns on
 * that field and on nothing else, and the link is "what prevents
 * double-counting": its job is to keep the bill in exactly one of the ledger
 * and the forecast at all times. Once the entry is gone the money is not in the
 * ledger, so the occurrence has to be back in the forecast — a link pointing at
 * an entry that no longer exists would keep it out of the forecast on the
 * strength of a payment that no longer happened, which is the same error the
 * overdue rule exists to refuse, pointing the other way.
 */
describe('deleting the entry that paid a bill returns the bill', () => {
  it('unlinks the occurrence and puts it back in the forecast, losing no money', async () => {
    const to = inMonths(1);
    const created = await createSeries(
      bill({ payee: uniqueName('Undone'), amountMinor: '-9100', firstDueOn: inDays(6) }),
    );
    const before = await expandThrough(to);
    const occurrenceId = await occurrenceIdOf(created.id, inDays(6));
    expect(before.scheduled.occurrences.map((row) => row.id)).toContain(occurrenceId);

    const paid = await payOccurrence(occurrenceId, {
      paidOn: inDays(6),
      amountMinor: '-9100',
      ledgerAccountId: ALICE_ACCOUNTS.checking,
    });
    const settled = await getProjection(to);
    expect(settled.scheduled.occurrences.map((row) => row.id)).not.toContain(
      occurrenceId,
    );

    const deleted = await request(h.app).delete(entryPath(paid.entry.id));
    expect(deleted.status).toBe(204);
    expect(await h.db.entry.findUnique({ where: { id: paid.entry.id } })).toBeNull();

    // Nothing dismisses an occurrence: the bill outlives the entry that paid it.
    const row = await h.db.scheduledOccurrence.findUnique({
      where: { id: occurrenceId },
    });
    expect(row).not.toBeNull();
    expect(row?.materializedEntryId).toBeNull();
    expect(row?.amountMinor).toBe(-9_100n);

    const after = await getProjection(to);
    expect(after.scheduled.occurrences.map((r) => r.id)).toContain(occurrenceId);
    expect(after.scheduled.netMinor).toBe(before.scheduled.netMinor);
    expect(after.projectedNetWorthMinor).toBe(before.projectedNetWorthMinor);
    expect(after.netWorthMinor).toBe(before.netWorthMinor);
  });

  it('leaves the forecast and the ledger agreeing about the money afterwards', async () => {
    const to = inMonths(1);
    const created = await createSeries(
      bill({ payee: uniqueName('Agreed'), amountMinor: '-4400', firstDueOn: inDays(6) }),
    );
    await expandThrough(to);
    const occurrenceId = await occurrenceIdOf(created.id, inDays(6));

    const paid = await payOccurrence(occurrenceId, {
      paidOn: inDays(6),
      amountMinor: '-4400',
      ledgerAccountId: ALICE_ACCOUNTS.checking,
    });
    expect((await request(h.app).delete(entryPath(paid.entry.id))).status).toBe(204);

    // The invariant, stated against the two tables rather than against an
    // earlier response: the bill is counted once, by the forecast.
    const after = await getProjection(to);
    expect(after.projectedNetWorthMinor).toBe(
      (await ledgerNetThrough(to)) + after.scheduled.netMinor,
    );
    expect(after.netWorthMinor).toBe(await ledgerNetThrough(TODAY));
    expect(
      after.scheduled.occurrences.find((row) => row.id === occurrenceId)?.amountMinor,
    ).toBe(-4_400n);
  });

  it('returns an overdue bill to the overdue group, not to the scheduled one', async () => {
    const to = inMonths(1);
    const created = await createSeries(
      bill({ payee: uniqueName('Overdue again'), amountMinor: '-2200', firstDueOn: inDays(-2) }),
    );
    const before = await expandThrough(to);
    const occurrenceId = await occurrenceIdOf(created.id, inDays(-2));
    expect(before.overdue.occurrences.map((row) => row.id)).toContain(occurrenceId);

    const paid = await payOccurrence(occurrenceId, {
      paidOn: TODAY,
      amountMinor: '-2200',
      ledgerAccountId: ALICE_ACCOUNTS.checking,
    });
    expect((await request(h.app).delete(entryPath(paid.entry.id))).status).toBe(204);

    const after = await getProjection(to);
    expect(after.overdue.occurrences.map((row) => row.id)).toContain(occurrenceId);
    expect(after.scheduled.occurrences.map((row) => row.id)).not.toContain(
      occurrenceId,
    );
    expect(after.overdue.netMinor).toBe(before.overdue.netMinor);
    // Overdue is outside the projected figure, so both figures come back too.
    expect(after.projectedNetWorthMinor).toBe(before.projectedNetWorthMinor);
    expect(after.netWorthMinor).toBe(before.netWorthMinor);
  });

  it('lets the bill be paid again, because it is no longer paid', async () => {
    const created = await createSeries(
      bill({ payee: uniqueName('Repaid'), amountMinor: '-1300', firstDueOn: inDays(6) }),
    );
    await expandThrough(inDays(10));
    const occurrenceId = await occurrenceIdOf(created.id, inDays(6));
    const body = {
      paidOn: inDays(6),
      amountMinor: '-1300',
      ledgerAccountId: ALICE_ACCOUNTS.checking,
    };

    const first = await payOccurrence(occurrenceId, body);
    // While the entry stands, a second payment is the 409 the link exists for.
    expectProblem(await request(h.app).post(pay(occurrenceId)).send(body), 409);

    expect((await request(h.app).delete(entryPath(first.entry.id))).status).toBe(204);

    const second = await payOccurrence(occurrenceId, body);
    expect(second.entry.id).not.toBe(first.entry.id);
    expect(second.occurrence.id).toBe(occurrenceId);
    expect(second.occurrence.materializedEntryId).toBe(second.entry.id);
    expect(
      await h.db.entry.count({ where: { id: { in: [first.entry.id, second.entry.id] } } }),
    ).toBe(1);
  });
});

describe('POST /occurrences/:id/pay — validation and isolation', () => {
  let occurrenceId = '';

  beforeAll(async () => {
    const created = await createSeries(
      bill({ payee: uniqueName('Guarded'), firstDueOn: inDays(8) }),
    );
    await expandThrough(inDays(12));
    occurrenceId = await occurrenceIdOf(created.id, inDays(8));
  });

  const body = (
    patch: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    paidOn: inDays(8),
    amountMinor: '-5000',
    ledgerAccountId: ALICE_ACCOUNTS.checking,
    ...patch,
  });

  it.each([
    ['a zero amount', { amountMinor: '0' }, 'amountMinor'],
    ['an amount as a number', { amountMinor: -5000 }, 'amountMinor'],
    ['a paid date that is not a date', { paidOn: 'today' }, 'paidOn'],
    ['a paid timestamp', { paidOn: '2027-02-01T00:00:00Z' }, 'paidOn'],
    ['a non-uuid account', { ledgerAccountId: 'checking' }, 'ledgerAccountId'],
  ])(
    'rejects %s, naming it, and posts nothing',
    async (_label, patch, path) => {
      const before = await h.db.entry.count({ where: { ownerId: ALICE } });
      expectValidationProblem(
        await request(h.app).post(pay(occurrenceId)).send(body(patch)),
        path,
      );
      expect(await h.db.entry.count({ where: { ownerId: ALICE } })).toBe(
        before,
      );
    },
  );

  it.each([['paidOn'], ['amountMinor'], ['ledgerAccountId']])(
    'requires %s — all three are editable, none is defaulted',
    async (field) => {
      const payload = body();
      delete payload[field];
      expectValidationProblem(
        await request(h.app).post(pay(occurrenceId)).send(payload),
        field,
      );
    },
  );

  it.each([['not-a-uuid'], ['12345']])(
    'rejects %s as an occurrence id',
    async (id) => {
      expectValidationProblem(
        await request(h.app).post(pay(id)).send(body()),
        'id',
      );
    },
  );

  it('answers 404 for an occurrence that does not exist', async () => {
    expectProblem(await request(h.app).post(pay(NOBODY)).send(body()), 404);
  });

  it('answers 404 for the decoy’s occurrence — not 403, which would confirm it', async () => {
    const asBlake = await h.as(BLAKE);
    const theirs = await createSeries(
      bill({
        payee: uniqueName('REEF bill'),
        ledgerAccountId: BLAKE_ACCOUNTS.checking,
        categoryId: BLAKE_ACCOUNTS.spending,
        firstDueOn: inDays(9),
      }),
      asBlake,
    );
    await getProjection(inDays(12), asBlake);
    const theirOccurrence = await occurrenceIdOf(theirs.id, inDays(9));

    const foreign = await request(h.app)
      .post(pay(theirOccurrence))
      .send(body({ paidOn: inDays(9) }));
    const absent = await request(h.app)
      .post(pay(NOBODY))
      .send(body({ paidOn: inDays(9) }));

    expectIndistinguishable(foreign, absent);
    expect(foreign.status).toBe(404);
    expect(
      await h.db.scheduledOccurrence.findUniqueOrThrow({
        where: { id: theirOccurrence },
      }),
    ).toHaveProperty('materializedEntryId', null);
  });

  it('refuses payment onto the decoy’s account, and posts nothing', async () => {
    const before = await h.db.entry.count();

    expectIndistinguishable(
      await request(h.app)
        .post(pay(occurrenceId))
        .send(body({ ledgerAccountId: BLAKE_ACCOUNTS.checking })),
      await request(h.app)
        .post(pay(occurrenceId))
        .send(body({ ledgerAccountId: NOBODY })),
    );

    expect(await h.db.entry.count()).toBe(before);
    expect(
      await h.db.scheduledOccurrence.findUniqueOrThrow({
        where: { id: occurrenceId },
      }),
    ).toHaveProperty('materializedEntryId', null);
  });

  it('refuses payment onto a category rather than an account', async () => {
    const res = await request(h.app)
      .post(pay(occurrenceId))
      .send(body({ ledgerAccountId: ALICE_ACCOUNTS.groceries }));
    expectProblem(res, 422);
    expect(
      await h.db.scheduledOccurrence.findUniqueOrThrow({
        where: { id: occurrenceId },
      }),
    ).toHaveProperty('materializedEntryId', null);
  });

  it('keeps the money the account’s balance sees to the entry alone', async () => {
    const created = await createSeries(
      bill({
        payee: uniqueName('Balance delta'),
        amountMinor: '-1234',
        ledgerAccountId: ALICE_ACCOUNTS.savings,
        firstDueOn: TODAY,
      }),
    );
    await expandThrough(inDays(4));
    const id = await occurrenceIdOf(created.id, TODAY);

    const readBalance = async (): Promise<bigint> => {
      const res = await request(h.app).get(balance(ALICE_ACCOUNTS.savings));
      expect(res.status).toBe(200);
      return AccountBalanceResponse.parse(res.body).balanceMinor;
    };

    const before = await readBalance();
    const res = await request(h.app).post(pay(id)).send({
      paidOn: TODAY,
      amountMinor: '-1234',
      ledgerAccountId: ALICE_ACCOUNTS.savings,
    });
    expect([200, 201]).toContain(res.status);

    expect(await readBalance()).toBe(before - 1_234n);
  });
});
