import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountBalanceResponse,
  CategoryLines,
  CategoryReport,
  CorrectionResponse,
  Entry,
  LedgerAccount,
  MAX_REPORT_MONTHS,
  TransactionPage,
  apiPath,
  routes,
  type CategoryLine,
  type MonthSpending,
} from '@pfm/contracts';
import { buildDecoyTenant } from '../../../prisma/seed/decoy-tenant.js';
import { buildDemoTenant, type Tenant } from '../../../prisma/seed/demo-tenant.js';
import { seedId } from '../../../prisma/seed/ids.js';
import {
  addDays,
  addMonths,
  dayOfMonth,
  daysInMonth,
  startOfMonth,
  todayUtc,
} from '../../../prisma/seed/time.js';
import {
  ALICE,
  ALICE_ACCOUNTS,
  BLAKE,
  BLAKE_ACCOUNTS,
  BLAKE_PROJECT_ID,
  connectRaw,
  reconcile,
  seededEntryId,
  startHarness,
  uniqueName,
  type Harness,
} from '../../test/harness.js';
import { expectProblem, expectValidationProblem } from '../../test/problem.js';

// US3 — "a report showing my expenses classified by category for each month".
// Every expected figure is derived from the seed builders' own drafts plus the
// rows present in the database that the seed did not write, summed in BigInt.
// Nothing is compared against the endpoint's own output, and no money value
// passes through a JS `number`.

const report = apiPath(routes.categoryReport);
const lines = (id: string): string => apiPath(routes.categoryReportLines(id));
const entries = apiPath(routes.entries);
const correction = (id: string): string => apiPath(routes.entryCorrection(id));

const iso = (value: Date): string => value.toISOString().slice(0, 10);
const ym = (value: Date | string): string =>
  (typeof value === 'string' ? value : iso(value)).slice(0, 7);
const monthEnd = (month: Date): Date => dayOfMonth(month, daysInMonth(month));

const TODAY_DATE = todayUtc();
const TODAY = iso(TODAY_DATE);
const CURRENT = startOfMonth(TODAY_DATE);
const monthAt = (offset: number): Date => addMonths(CURRENT, offset);

/** The seeded history: six months ending with the current one. */
const FIRST = monthAt(-5);
const PERIOD = { from: iso(FIRST), to: iso(monthEnd(CURRENT)) };

const monthsIn = (from: string, to: string): string[] => {
  const out: string[] = [];
  let cursor = startOfMonth(new Date(`${from}T00:00:00.000Z`));
  const last = ym(to);
  while (ym(cursor) <= last) {
    out.push(ym(cursor));
    cursor = addMonths(cursor, 1);
  }
  return out;
};

type SeedView = {
  entryIds: string[];
  entries: Map<string, { occurredOn: string; correction: boolean }>;
  lines: {
    id: string;
    entryId: string;
    ledgerAccountId: string;
    amountMinor: bigint;
    excluded: boolean;
  }[];
  expenseIds: Set<string>;
};

const viewOf = (tenant: Tenant): SeedView => {
  const allEntries = [...tenant.entries, ...tenant.corrections.entries];
  const allLines = [...tenant.lines, ...tenant.corrections.lines];
  return {
    entryIds: allEntries.map((e) => String(e.id)),
    entries: new Map(
      allEntries.map((e) => [
        String(e.id),
        {
          occurredOn: iso(e.occurredOn as Date),
          correction: Boolean(e.reversesEntryId) || Boolean(e.replacesEntryId),
        },
      ]),
    ),
    lines: allLines.map((l) => ({
      id: String(l.id),
      entryId: String(l.entryId),
      ledgerAccountId: String(l.ledgerAccountId),
      amountMinor: BigInt(l.amountMinor as bigint),
      excluded: l.excludedFromReporting === true,
    })),
    expenseIds: new Set(
      tenant.accounts.filter((a) => a.kind === 'expense').map((a) => String(a.id)),
    ),
  };
};

const aliceSeed = buildDemoTenant(ALICE, TODAY_DATE);
const SEED: Record<string, SeedView> = {
  [ALICE]: viewOf(aliceSeed),
  [BLAKE]: viewOf(buildDecoyTenant(TODAY_DATE)),
};

type ExpectedLine = {
  lineId: string;
  entryId: string;
  ledgerAccountId: string;
  occurredOn: string;
  amountMinor: bigint;
  correction: boolean;
  fromSeed: boolean;
};

let h: Harness;

/** Every reportable expense line an owner has in `[from, to]`. */
const expectedLines = async (
  ownerId: string,
  from: string,
  to: string,
): Promise<ExpectedLine[]> => {
  const seed = SEED[ownerId];
  if (!seed) throw new Error(`no seed view for ${ownerId}`);
  const out: ExpectedLine[] = [];

  for (const line of seed.lines) {
    if (line.excluded || !seed.expenseIds.has(line.ledgerAccountId)) continue;
    const header = seed.entries.get(line.entryId);
    if (!header || header.occurredOn < from || header.occurredOn > to) continue;
    out.push({
      lineId: line.id,
      entryId: line.entryId,
      ledgerAccountId: line.ledgerAccountId,
      occurredOn: header.occurredOn,
      amountMinor: line.amountMinor,
      correction: header.correction,
      fromSeed: true,
    });
  }

  const extra = await h.db.entryLine.findMany({
    where: {
      entryId: { notIn: seed.entryIds },
      excludedFromReporting: false,
      ledgerAccount: { ownerId, kind: 'expense' },
      entry: { ownerId },
    },
    select: {
      id: true,
      entryId: true,
      ledgerAccountId: true,
      amountMinor: true,
      entry: {
        select: { occurredOn: true, reversesEntryId: true, replacesEntryId: true },
      },
    },
  });
  for (const line of extra) {
    const on = iso(line.entry.occurredOn);
    if (on < from || on > to) continue;
    out.push({
      lineId: line.id,
      entryId: line.entryId,
      ledgerAccountId: line.ledgerAccountId,
      occurredOn: on,
      amountMinor: line.amountMinor,
      correction:
        line.entry.reversesEntryId !== null || line.entry.replacesEntryId !== null,
      fromSeed: false,
    });
  }

  return out;
};

type Agg = { total: bigint; correction: boolean; seedLines: number };

const aggregate = (rows: readonly ExpectedLine[]): Map<string, Map<string, Agg>> => {
  const byMonth = new Map<string, Map<string, Agg>>();
  for (const row of rows) {
    const month = ym(row.occurredOn);
    const cats = byMonth.get(month) ?? new Map<string, Agg>();
    const agg = cats.get(row.ledgerAccountId) ?? { total: 0n, correction: false, seedLines: 0 };
    agg.total += row.amountMinor;
    agg.correction ||= row.correction;
    agg.seedLines += row.fromSeed ? 1 : 0;
    cats.set(row.ledgerAccountId, agg);
    byMonth.set(month, cats);
  }
  return byMonth;
};

const namesOf = async (ownerId: string): Promise<Map<string, string>> =>
  new Map(
    (
      await h.db.ledgerAccount.findMany({
        where: { ownerId, kind: 'expense' },
        select: { id: true, name: true },
      })
    ).map((a) => [a.id, a.name]),
  );

const getReport = async (
  query: Record<string, string>,
  app = h.app,
): Promise<CategoryReport> => {
  const res = await request(app).get(report).query(query);
  expect(res.status).toBe(200);
  return CategoryReport.parse(res.body);
};

const getLines = async (
  id: string,
  query: Record<string, string>,
  app = h.app,
): Promise<CategoryLines> => {
  const res = await request(app).get(lines(id)).query(query);
  expect(res.status).toBe(200);
  return CategoryLines.parse(res.body);
};

const monthOf = (body: CategoryReport, month: string): MonthSpending => {
  const found = body.months.find((m) => m.month === month);
  expect(found, `month ${month} missing from the series`).toBeDefined();
  return found as MonthSpending;
};

/** One month of the response against the independent derivation. */
const expectMonthMatches = (
  month: MonthSpending,
  want: Map<string, Agg> | undefined,
  names: Map<string, string>,
): void => {
  const expected = want ?? new Map<string, Agg>();
  let total = 0n;
  for (const agg of expected.values()) total += agg.total;

  expect(month.totalMinor, `${month.month} total`).toBe(total);

  const ids = month.categories.map((c) => c.ledgerAccountId);
  expect(new Set(ids).size, `${month.month} repeats a category`).toBe(ids.length);

  for (const [id, agg] of expected) {
    const row = month.categories.find((c) => c.ledgerAccountId === id);
    expect(row, `${month.month}: category ${names.get(id) ?? id} missing`).toBeDefined();
    expect(row?.totalMinor, `${month.month}: ${names.get(id)} total`).toBe(agg.total);
    expect(row?.includesCorrection, `${month.month}: ${names.get(id)} includesCorrection`).toBe(
      agg.correction,
    );
    expect(row?.name).toBe(names.get(id));
  }
  for (const row of month.categories) {
    if (expected.has(row.ledgerAccountId)) continue;
    // A category with nothing behind it may be listed only as an honest zero.
    expect(row.totalMinor, `${month.month}: unexpected ${row.name}`).toBe(0n);
    expect(row.includesCorrection).toBe(false);
  }
};

const postEntry = async (body: Record<string, unknown>, app = h.app): Promise<Entry> => {
  const res = await request(app).post(entries).send(body);
  expect([200, 201]).toContain(res.status);
  return Entry.parse(res.body);
};

/** There is no create endpoint for categories in US3; the row is a fixture. */
const createExpenseCategory = async (label: string, ownerId = ALICE): Promise<string> =>
  (
    await h.db.ledgerAccount.create({
      data: { ownerId, name: uniqueName(label), kind: 'expense' },
      select: { id: true },
    })
  ).id;

const createAsset = async (label: string): Promise<string> => {
  const res = await request(h.app)
    .post(apiPath(routes.accounts))
    .send({ name: uniqueName(label), kind: 'asset' });
  expect([200, 201]).toContain(res.status);
  return LedgerAccount.parse(res.body).id;
};

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

describe('the seed this test derives from is the seed in the database', () => {
  it('finds every drafted entry of both tenants', async () => {
    for (const ownerId of [ALICE, BLAKE]) {
      const ids = SEED[ownerId]?.entryIds ?? [];
      expect(ids.length).toBeGreaterThan(0);
      expect(await h.db.entry.count({ where: { id: { in: ids }, ownerId } })).toBe(ids.length);
    }
  });
});

describe('GET /reports/categories — shape', () => {
  it('echoes the period and returns one month per calendar month, in order', async () => {
    const body = await getReport(PERIOD);

    expect(body.from).toBe(PERIOD.from);
    expect(body.to).toBe(PERIOD.to);
    expect(body.months.map((m) => m.month)).toEqual(monthsIn(PERIOD.from, PERIOD.to));
    expect(body.months).toHaveLength(6);
  });

  it('puts every money figure on the wire as an integer string', async () => {
    const res = await request(h.app).get(report).query(PERIOD);
    expect(res.status).toBe(200);
    const months = (res.body as { months: Record<string, unknown>[] }).months;

    expect(months.length).toBeGreaterThan(0);
    for (const month of months) {
      expect(typeof month['totalMinor']).toBe('string');
      expect(month['totalMinor']).toMatch(/^-?\d+$/);
      for (const cat of month['categories'] as Record<string, unknown>[]) {
        expect(typeof cat['totalMinor']).toBe('string');
        expect(cat['totalMinor']).toMatch(/^-?\d+$/);
        expect(typeof cat['includesCorrection']).toBe('boolean');
      }
    }
  });

  it('reports expenses only — never an income, asset, liability or equity row', async () => {
    const body = await getReport(PERIOD);
    const expense = new Set(
      (
        await h.db.ledgerAccount.findMany({
          where: { ownerId: ALICE, kind: 'expense' },
          select: { id: true },
        })
      ).map((a) => a.id),
    );

    for (const month of body.months) {
      for (const cat of month.categories) {
        expect(expense.has(cat.ledgerAccountId), `${cat.name} is not an expense`).toBe(true);
      }
    }
    const everyId = body.months.flatMap((m) => m.categories.map((c) => c.ledgerAccountId));
    for (const id of [
      ALICE_ACCOUNTS.salary,
      ALICE_ACCOUNTS.checking,
      ALICE_ACCOUNTS.visa,
      ALICE_ACCOUNTS.savings,
      ALICE_ACCOUNTS.openingBalances,
    ]) {
      expect(everyId).not.toContain(id);
    }
  });

  it('sorts each month’s categories by amount, largest first, a negative last', async () => {
    const body = await getReport(PERIOD);

    for (const month of body.months) {
      const totals = month.categories.map((c) => c.totalMinor);
      for (let i = 1; i < totals.length; i += 1) {
        expect(
          (totals[i - 1] ?? 0n) >= (totals[i] ?? 0n),
          `${month.month} is out of order at ${i}`,
        ).toBe(true);
      }
    }
  });
});

describe('category totals, derived independently', () => {
  it('matches every category of a known seeded month', async () => {
    const month = monthAt(-2);
    const from = iso(month);
    const to = iso(monthEnd(month));
    const want = aggregate(await expectedLines(ALICE, from, to)).get(ym(month));

    const seeded = [...(want?.values() ?? [])].reduce((n, a) => n + a.seedLines, 0);
    expect(seeded).toBeGreaterThan(5);

    // Rent is scheduled on the 1st of every seeded month, so it anchors the
    // expectation to a named draft rather than to an aggregate alone.
    const rentLine = SEED[ALICE]?.lines.find(
      (l) => l.id === seedId(`line:${ym(month)}-rent:0`),
    );
    expect(rentLine).toBeDefined();
    expect(want?.get(seedId(`account:${ALICE}:rent`))?.total).toBeGreaterThanOrEqual(
      rentLine?.amountMinor ?? 0n,
    );

    const body = await getReport({ from, to });
    expect(body.months).toHaveLength(1);
    expectMonthMatches(monthOf(body, ym(month)), want, await namesOf(ALICE));
  });

  it('matches every category of every month of the seeded history', async () => {
    const want = aggregate(await expectedLines(ALICE, PERIOD.from, PERIOD.to));
    const names = await namesOf(ALICE);
    const body = await getReport(PERIOD);

    for (const month of body.months) {
      expectMonthMatches(month, want.get(month.month), names);
    }
  });

  it('gives each month a total that is the API’s own, equal to the derived total', async () => {
    const want = aggregate(await expectedLines(ALICE, PERIOD.from, PERIOD.to));
    const body = await getReport(PERIOD);

    for (const month of body.months) {
      let derived = 0n;
      for (const agg of want.get(month.month)?.values() ?? []) derived += agg.total;
      expect(month.totalMinor).toBe(derived);
      expect(month.totalMinor).toBe(
        month.categories.reduce((sum, c) => sum + c.totalMinor, 0n),
      );
    }
    expect(body.months.some((m) => m.totalMinor > 0n)).toBe(true);
  });

  it('carries an amount larger than Number.MAX_SAFE_INTEGER without loss', async () => {
    const huge = 9_007_199_254_740_993n;
    const category = await createExpenseCategory('Huge Probe');
    const funding = await createAsset('Huge Funding');
    const month = monthAt(-4);
    const on = iso(dayOfMonth(month, 17));

    await postEntry({
      occurredOn: on,
      payee: 'Very large',
      lines: [
        { ledgerAccountId: category, amountMinor: huge.toString() },
        { ledgerAccountId: funding, amountMinor: (-huge).toString() },
      ],
    });

    const res = await request(h.app).get(report).query({ from: on, to: on });
    expect(res.status).toBe(200);
    const wire = (res.body as { months: { categories: Record<string, unknown>[] }[] }).months[0]
      ?.categories.find((c) => c['ledgerAccountId'] === category);
    expect(wire?.['totalMinor']).toBe(huge.toString());

    const drill = await getLines(category, { from: on, to: on });
    expect(drill.lines.map((l) => l.amountMinor)).toEqual([huge]);
  });
});

describe('the month series has no gaps', () => {
  it('returns a zero month for every month with no spending', async () => {
    const from = iso(addMonths(FIRST, -3));
    const body = await getReport({ from, to: PERIOD.to });
    const want = aggregate(await expectedLines(ALICE, from, PERIOD.to));
    const names = await namesOf(ALICE);

    expect(body.months.map((m) => m.month)).toEqual(monthsIn(from, PERIOD.to));
    expect(body.months).toHaveLength(9);

    const empty = body.months.filter((m) => !want.has(m.month));
    expect(empty.length).toBeGreaterThan(0);
    for (const month of empty) {
      expect(month.totalMinor).toBe(0n);
      expect(month.categories.every((c) => c.totalMinor === 0n)).toBe(true);
    }
    for (const month of body.months) expectMonthMatches(month, want.get(month.month), names);
  });

  it('returns "0" — present, not null — for a zero month on the wire', async () => {
    const res = await request(h.app).get(report).query({ from: '2001-01-01', to: '2001-12-31' });
    expect(res.status).toBe(200);
    const months = (res.body as { months: Record<string, unknown>[] }).months;

    expect(months.map((m) => m['month'])).toEqual(monthsIn('2001-01-01', '2001-12-31'));
    for (const month of months) expect(month['totalMinor']).toBe('0');
  });

  it('counts calendar months, not 30-day spans', async () => {
    const twoDays = await getReport({ from: '2025-03-31', to: '2025-04-01' });
    expect(twoDays.months.map((m) => m.month)).toEqual(['2025-03', '2025-04']);

    const oneDay = await getReport({ from: '2025-02-14', to: '2025-02-14' });
    expect(oneDay.months.map((m) => m.month)).toEqual(['2025-02']);

    const acrossYear = await getReport({ from: '2024-11-30', to: '2025-02-01' });
    expect(acrossYear.months.map((m) => m.month)).toEqual([
      '2024-11',
      '2024-12',
      '2025-01',
      '2025-02',
    ]);
  });

  it(`accepts exactly ${MAX_REPORT_MONTHS} months and returns every one of them`, async () => {
    const body = await getReport({ from: '2024-01-01', to: '2025-12-31' });
    expect(body.months).toHaveLength(MAX_REPORT_MONTHS);
  });
});

describe('exclusion — absent from the report, present in the balance', () => {
  let category: string;
  let funding: string;
  let keptLineId: string;
  let excludedLineId: string;
  let fullyExcludedLineId: string;
  const partialMonth = monthAt(-2);
  const excludedMonth = monthAt(-3);

  beforeAll(async () => {
    category = await createExpenseCategory('Exclusion Probe');
    funding = await createAsset('Exclusion Funding');

    const partial = await postEntry({
      occurredOn: iso(dayOfMonth(partialMonth, 10)),
      payee: 'Team lunch, partly reimbursed',
      lines: [
        { ledgerAccountId: category, amountMinor: '10000', excludedFromReporting: true },
        { ledgerAccountId: category, amountMinor: '2500' },
        { ledgerAccountId: funding, amountMinor: '-12500' },
      ],
    });
    keptLineId = partial.lines.find((l) => l.ledgerAccountId === category && !l.excludedFromReporting)?.id ?? '';
    excludedLineId = partial.lines.find((l) => l.excludedFromReporting)?.id ?? '';

    const full = await postEntry({
      occurredOn: iso(dayOfMonth(excludedMonth, 10)),
      payee: 'Fully reimbursed',
      lines: [
        { ledgerAccountId: category, amountMinor: '4000', excludedFromReporting: true },
        { ledgerAccountId: funding, amountMinor: '-4000' },
      ],
    });
    fullyExcludedLineId = full.lines.find((l) => l.excludedFromReporting)?.id ?? '';

    expect(keptLineId).not.toBe('');
    expect(excludedLineId).not.toBe('');
    expect(fullyExcludedLineId).not.toBe('');
  });

  it('counts only the reported part of a partly excluded purchase', async () => {
    const body = await getReport({ from: iso(excludedMonth), to: iso(monthEnd(partialMonth)) });

    const partial = monthOf(body, ym(partialMonth)).categories.find(
      (c) => c.ledgerAccountId === category,
    );
    expect(partial?.totalMinor).toBe(2_500n);

    const full = monthOf(body, ym(excludedMonth)).categories.find(
      (c) => c.ledgerAccountId === category,
    );
    expect(full?.totalMinor ?? 0n).toBe(0n);
  });

  it('leaves the excluded line out of the drill-down', async () => {
    const drill = await getLines(category, {
      from: iso(excludedMonth),
      to: iso(monthEnd(partialMonth)),
    });
    const ids = drill.lines.map((l) => l.lineId);

    expect(ids).toEqual([keptLineId]);
    expect(ids).not.toContain(excludedLineId);
    expect(ids).not.toContain(fullyExcludedLineId);
    expect(drill.lines[0]?.amountMinor).toBe(2_500n);
  });

  it('still moves the funding account’s balance by the whole amount', async () => {
    const res = await request(h.app).get(apiPath(routes.accountBalance(funding)));
    expect(res.status).toBe(200);
    expect(AccountBalanceResponse.parse(res.body).balanceMinor).toBe(-16_500n);
  });

  it('honours the seeded reimbursed lunch: $40 reported, $60 excluded', async () => {
    const lunchOn = iso(addDays(TODAY_DATE, -10));
    const reported = seedId('line:team-lunch:0');
    const excluded = seedId('line:team-lunch:1');
    expect(SEED[ALICE]?.lines.find((l) => l.id === excluded)?.excluded).toBe(true);

    const drill = await getLines(ALICE_ACCOUNTS.dining, { from: lunchOn, to: lunchOn });
    const ids = drill.lines.map((l) => l.lineId);
    expect(ids).toContain(reported);
    expect(ids).not.toContain(excluded);
    expect(drill.lines.find((l) => l.lineId === reported)?.amountMinor).toBe(4_000n);

    const want = aggregate(await expectedLines(ALICE, lunchOn, lunchOn));
    const body = await getReport({ from: lunchOn, to: lunchOn });
    expectMonthMatches(monthOf(body, ym(lunchOn)), want.get(ym(lunchOn)), await namesOf(ALICE));
    expect(
      monthOf(body, ym(lunchOn)).categories.find((c) => c.ledgerAccountId === ALICE_ACCOUNTS.dining)
        ?.totalMinor,
    ).toBe(want.get(ym(lunchOn))?.get(ALICE_ACCOUNTS.dining)?.total);
  });
});

describe('corrections — ARCHITECTURE §4 "Known cost"', () => {
  let category: string;
  let originalId: string;
  let reversalId: string;
  let replacementId: string;
  const originalMonth = monthAt(-2);
  const originalOn = iso(dayOfMonth(originalMonth, 15));

  beforeAll(async () => {
    category = await createExpenseCategory('Correction Probe');
    const original = await postEntry({
      occurredOn: originalOn,
      payee: 'Probe Merchant',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: category,
      amountMinor: '-7500',
    });
    originalId = original.id;
    await reconcile(h.db, originalId);

    const res = await request(h.app)
      .post(correction(originalId))
      .send({
        replacement: {
          payee: 'Probe Merchant',
          accountId: ALICE_ACCOUNTS.checking,
          categoryId: ALICE_ACCOUNTS.dining,
          amountMinor: '-7500',
        },
      });
    expect([200, 201]).toContain(res.status);
    const posted = CorrectionResponse.parse(res.body);
    reversalId = posted.reversal.id;
    replacementId = posted.replacement.id;
    expect(posted.reversal.occurredOn).toBe(TODAY);
  });

  it('shows a negative category total in the month the reversal lands — this is correct', async () => {
    const body = await getReport(PERIOD);
    const current = monthOf(body, ym(CURRENT));
    const row = current.categories.find((c) => c.ledgerAccountId === category);

    // Pinned deliberately: an ABS() "fix" would turn this into +7500.
    expect(row?.totalMinor).toBe(-7_500n);
    expect(row?.includesCorrection).toBe(true);

    const last = current.categories.at(-1);
    expect(last?.totalMinor).toBeLessThanOrEqual(-7_500n);
    const firstNegative = current.categories.findIndex((c) => c.totalMinor < 0n);
    expect(current.categories.slice(firstNegative).every((c) => c.totalMinor < 0n)).toBe(true);
  });

  it('leaves the original month positive and unflagged', async () => {
    const body = await getReport(PERIOD);
    const row = monthOf(body, ym(originalMonth)).categories.find(
      (c) => c.ledgerAccountId === category,
    );

    expect(row?.totalMinor).toBe(7_500n);
    expect(row?.includesCorrection).toBe(false);
  });

  it('lets the month total go down by the reversal, as derived', async () => {
    const want = aggregate(await expectedLines(ALICE, PERIOD.from, PERIOD.to));
    const body = await getReport(PERIOD);

    expectMonthMatches(monthOf(body, ym(CURRENT)), want.get(ym(CURRENT)), await namesOf(ALICE));
  });

  it('drills down to both lines, category-side, with the reversal negative and linked', async () => {
    const drill = await getLines(category, PERIOD);

    expect(drill.ledgerAccountId).toBe(category);
    expect(drill.from).toBe(PERIOD.from);
    expect(drill.to).toBe(PERIOD.to);
    expect(drill.lines.map((l) => l.entryId)).toEqual([reversalId, originalId]);

    const [reversal, original] = drill.lines as [CategoryLine, CategoryLine];
    expect(reversal.amountMinor).toBe(-7_500n);
    expect(reversal.occurredOn).toBe(TODAY);
    expect(reversal.reverses).toEqual({ id: originalId, occurredOn: originalOn });
    expect(reversal.replaces).toBeNull();
    expect(reversal.reversedBy).toBeNull();

    expect(original.amountMinor).toBe(7_500n);
    expect(original.occurredOn).toBe(originalOn);
    expect(original.reversedBy).toEqual({ id: reversalId, occurredOn: TODAY });
    expect(original.reverses).toBeNull();
    expect(original.replaces).toBeNull();

    for (const line of drill.lines) {
      expect(line.accounts).toEqual([
        { ledgerAccountId: ALICE_ACCOUNTS.checking, name: 'Everyday Checking' },
      ]);
      expect(line.payee).toBe('Probe Merchant');
    }
  });

  it('links the replacement back to the original in its own category', async () => {
    const drill = await getLines(ALICE_ACCOUNTS.dining, { from: TODAY, to: TODAY });
    const line = drill.lines.find((l) => l.entryId === replacementId);

    expect(line?.amountMinor).toBe(7_500n);
    expect(line?.replaces).toEqual({ id: originalId, occurredOn: originalOn });
    expect(line?.reverses).toBeNull();
  });

  it('never flips the category side to match the register', async () => {
    const drill = await getLines(category, { from: originalOn, to: originalOn });
    const res = await request(h.app)
      .get(entries)
      .query({ accountId: ALICE_ACCOUNTS.checking, from: originalOn, to: originalOn });
    expect(res.status).toBe(200);
    const row = TransactionPage.parse(res.body).data.find((r) => r.entryId === originalId);

    expect(row?.amountMinor).toBe(-7_500n);
    expect(drill.lines.find((l) => l.entryId === originalId)?.amountMinor).toBe(7_500n);
  });
});

describe('includesCorrection — exactly the categories a correction touched', () => {
  it('flags Groceries and Dining in the month the seeded correction was posted', async () => {
    const body = await getReport(PERIOD);
    const current = monthOf(body, ym(CURRENT));
    const flag = (id: string): boolean | undefined =>
      current.categories.find((c) => c.ledgerAccountId === id)?.includesCorrection;

    expect(flag(ALICE_ACCOUNTS.groceries)).toBe(true);
    expect(flag(ALICE_ACCOUNTS.dining)).toBe(true);
  });

  it('flags no category in any month other than the one corrections land in', async () => {
    const body = await getReport(PERIOD);

    for (const month of body.months) {
      if (month.month === ym(CURRENT)) continue;
      for (const cat of month.categories) {
        expect(cat.includesCorrection, `${month.month}: ${cat.name}`).toBe(false);
      }
    }
  });

  it('does not flag the reconciled month’s original, only the entries that correct it', async () => {
    const reconciled = monthAt(-1);
    const body = await getReport({ from: iso(reconciled), to: iso(monthEnd(reconciled)) });
    const groceries = monthOf(body, ym(reconciled)).categories.find(
      (c) => c.ledgerAccountId === ALICE_ACCOUNTS.groceries,
    );

    expect(groceries).toBeDefined();
    expect(groceries?.includesCorrection).toBe(false);
  });

  it('flags in the current month exactly the categories the derivation says were touched', async () => {
    const want = aggregate(await expectedLines(ALICE, PERIOD.from, PERIOD.to)).get(ym(CURRENT));
    const body = await getReport(PERIOD);
    const flagged = monthOf(body, ym(CURRENT))
      .categories.filter((c) => c.includesCorrection)
      .map((c) => c.ledgerAccountId)
      .sort();
    const derived = [...(want ?? new Map<string, Agg>())]
      .filter(([, agg]) => agg.correction)
      .map(([id]) => id)
      .sort();

    expect(flagged).toEqual(derived);
    expect(flagged).toContain(ALICE_ACCOUNTS.groceries);
    expect(flagged).toContain(ALICE_ACCOUNTS.dining);
  });
});

describe('GET /reports/categories/:ledgerAccountId/lines — drill-down', () => {
  it('returns exactly the category’s reportable lines, newest first', async () => {
    const want = (await expectedLines(ALICE, PERIOD.from, PERIOD.to)).filter(
      (l) => l.ledgerAccountId === ALICE_ACCOUNTS.groceries,
    );
    expect(want.filter((l) => l.fromSeed).length).toBeGreaterThan(5);

    const drill = await getLines(ALICE_ACCOUNTS.groceries, PERIOD);

    expect(new Set(drill.lines.map((l) => l.lineId))).toEqual(new Set(want.map((l) => l.lineId)));
    expect(drill.lines).toHaveLength(want.length);
    for (const line of drill.lines) {
      const expected = want.find((w) => w.lineId === line.lineId);
      expect(line.amountMinor).toBe(expected?.amountMinor);
      expect(line.occurredOn).toBe(expected?.occurredOn);
      expect(line.entryId).toBe(expected?.entryId);
    }
    for (let i = 1; i < drill.lines.length; i += 1) {
      expect((drill.lines[i - 1]?.occurredOn ?? '') >= (drill.lines[i]?.occurredOn ?? '')).toBe(
        true,
      );
    }
  });

  it('agrees with the report’s category total for each month', async () => {
    const body = await getReport(PERIOD);
    for (const month of body.months) {
      const start = `${month.month}-01`;
      const end = iso(monthEnd(new Date(`${start}T00:00:00.000Z`)));
      const drill = await getLines(ALICE_ACCOUNTS.groceries, { from: start, to: end });
      const sum = drill.lines.reduce((total, l) => total + l.amountMinor, 0n);
      const row = month.categories.find((c) => c.ledgerAccountId === ALICE_ACCOUNTS.groceries);
      expect(sum, month.month).toBe(row?.totalMinor ?? 0n);
    }
  });

  it('shows the seeded café reversal negative, linked to the original', async () => {
    const drill = await getLines(ALICE_ACCOUNTS.groceries, PERIOD);
    const reversal = drill.lines.find((l) => l.entryId === seededEntryId('cafe-reversal'));
    const original = drill.lines.find((l) => l.entryId === seededEntryId('cafe-original'));
    const originalOn = iso(dayOfMonth(monthAt(-1), 14));

    expect(reversal?.amountMinor).toBe(-2_400n);
    expect(reversal?.occurredOn).toBe(TODAY);
    expect(reversal?.reverses).toEqual({ id: seededEntryId('cafe-original'), occurredOn: originalOn });

    expect(original?.amountMinor).toBe(2_400n);
    expect(original?.occurredOn).toBe(originalOn);
    expect(original?.reversedBy).toEqual({ id: seededEntryId('cafe-reversal'), occurredOn: TODAY });

    const dining = await getLines(ALICE_ACCOUNTS.dining, { from: TODAY, to: TODAY });
    expect(
      dining.lines.find((l) => l.entryId === seededEntryId('cafe-replacement'))?.replaces,
    ).toEqual({ id: seededEntryId('cafe-original'), occurredOn: originalOn });
  });

  it('names the funding account on the other side, category-side positive', async () => {
    const marketOn = iso(addDays(TODAY_DATE, -2));
    const hardwareOn = iso(addDays(TODAY_DATE, -3));

    const market = (await getLines(ALICE_ACCOUNTS.groceries, { from: marketOn, to: marketOn }))
      .lines.find((l) => l.lineId === seedId('line:split-market:0'));
    expect(market?.amountMinor).toBe(6_010n);
    expect(market?.payee).toBe('Corner Market');
    expect(market?.accounts).toEqual([
      { ledgerAccountId: ALICE_ACCOUNTS.visa, name: 'Visa Credit Card' },
    ]);

    const hardware = (
      await getLines(ALICE_ACCOUNTS.household, { from: hardwareOn, to: hardwareOn })
    ).lines.find((l) => l.lineId === seedId('line:split-hardware:1'));
    expect(hardware?.amountMinor).toBe(3_000n);
    expect(hardware?.accounts).toEqual([
      { ledgerAccountId: ALICE_ACCOUNTS.checking, name: 'Everyday Checking' },
    ]);
  });

  it('lists every funding account of a purchase paid from two, and none for a reclassification', async () => {
    const category = await createExpenseCategory('Funding Probe');
    const other = await createExpenseCategory('Funding Probe Other');
    const on = iso(dayOfMonth(monthAt(-4), 9));

    const twoPayers = await postEntry({
      occurredOn: on,
      payee: 'Paid two ways',
      lines: [
        { ledgerAccountId: category, amountMinor: '9000' },
        { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-5000' },
        { ledgerAccountId: ALICE_ACCOUNTS.visa, amountMinor: '-4000' },
      ],
    });
    const reclass = await postEntry({
      occurredOn: on,
      payee: 'Reclassified',
      lines: [
        { ledgerAccountId: category, amountMinor: '1000' },
        { ledgerAccountId: other, amountMinor: '-1000' },
      ],
    });

    const drill = await getLines(category, { from: on, to: on });
    const split = drill.lines.find((l) => l.entryId === twoPayers.id);
    expect(split?.amountMinor).toBe(9_000n);
    expect(new Set(split?.accounts.map((a) => a.ledgerAccountId))).toEqual(
      new Set([ALICE_ACCOUNTS.checking, ALICE_ACCOUNTS.visa]),
    );
    expect(drill.lines.find((l) => l.entryId === reclass.id)?.accounts).toEqual([]);

    const otherDrill = await getLines(other, { from: on, to: on });
    expect(otherDrill.lines.map((l) => l.amountMinor)).toEqual([-1_000n]);
  });

  it('returns an empty list, not an error, for a period with no lines', async () => {
    const drill = await getLines(ALICE_ACCOUNTS.groceries, { from: '2001-01-01', to: '2001-01-31' });
    expect(drill.lines).toEqual([]);
  });

  it('puts every amount on the wire as a string', async () => {
    const res = await request(h.app).get(lines(ALICE_ACCOUNTS.groceries)).query(PERIOD);
    expect(res.status).toBe(200);
    const rows = (res.body as { lines: Record<string, unknown>[] }).lines;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row['amountMinor']).toBe('string');
      expect(row['amountMinor']).toMatch(/^-?\d+$/);
    }
  });

  it('answers 404 for a category id that does not exist', async () => {
    expectProblem(
      await request(h.app).get(lines('00000000-0000-4000-8000-0000000000cd')).query(PERIOD),
      404,
    );
  });

  it.each([
    ['an income category', ALICE_ACCOUNTS.salary],
    ['an asset account', ALICE_ACCOUNTS.checking],
    ['a liability account', ALICE_ACCOUNTS.visa],
    ['the equity opening-balances account', ALICE_ACCOUNTS.openingBalances],
  ])('refuses to drill into %s — US3 is expenses only', async (_label, id) => {
    const res = await request(h.app).get(lines(id)).query(PERIOD);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expectProblem(res, res.status);
    expect(res.body).not.toHaveProperty('lines');
  });
});

describe('tenancy — B’s spending never appears for A', () => {
  const blakeRange = { from: iso(monthAt(-2)), to: PERIOD.to };

  it('keeps the decoy’s categories and money out of A’s report', async () => {
    const res = await request(h.app).get(report).query(blakeRange);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/reef/i);

    const body = CategoryReport.parse(res.body);
    const ids = body.months.flatMap((m) => m.categories.map((c) => c.ledgerAccountId));
    for (const id of Object.values(BLAKE_ACCOUNTS)) expect(ids).not.toContain(id);

    const want = aggregate(await expectedLines(ALICE, blakeRange.from, blakeRange.to));
    const blake = aggregate(await expectedLines(BLAKE, blakeRange.from, blakeRange.to));
    expect(blake.size).toBeGreaterThan(0);
    const names = await namesOf(ALICE);
    for (const month of body.months) expectMonthMatches(month, want.get(month.month), names);
  });

  it('does not move A’s report when B spends', async () => {
    const before = await getReport(PERIOD);

    await postEntry(
      {
        occurredOn: TODAY,
        payee: 'REEF splurge',
        accountId: BLAKE_ACCOUNTS.checking,
        categoryId: BLAKE_ACCOUNTS.spending,
        amountMinor: '-98765432',
      },
      await h.as(BLAKE),
    );

    const after = await getReport(PERIOD);
    expect(after).toEqual(before);
  });

  it('serves B its own spending, derived from B’s rows only', async () => {
    const asBlake = await h.as(BLAKE);
    const body = await getReport(blakeRange, asBlake);
    const want = aggregate(await expectedLines(BLAKE, blakeRange.from, blakeRange.to));
    const names = await namesOf(BLAKE);

    for (const month of body.months) expectMonthMatches(month, want.get(month.month), names);
    const ids = body.months.flatMap((m) => m.categories.map((c) => c.ledgerAccountId));
    expect(ids).toContain(BLAKE_ACCOUNTS.spending);
    for (const id of Object.values(ALICE_ACCOUNTS)) expect(ids).not.toContain(id);
  });

  it('answers 404 — never 403 — when A drills into B’s category', async () => {
    const res: Response = await request(h.app).get(lines(BLAKE_ACCOUNTS.spending)).query(blakeRange);

    expectProblem(res, 404);
    expect(JSON.stringify(res.body)).not.toMatch(/reef/i);
  });

  it('answers 404 when B drills into A’s category', async () => {
    const res = await request(await h.as(BLAKE)).get(lines(ALICE_ACCOUNTS.groceries)).query(PERIOD);

    expectProblem(res, 404);
    expect(JSON.stringify(res.body)).not.toContain('Riverside');
  });

  it('never returns B’s project spending to A through the projectId filter', async () => {
    const res = await request(h.app)
      .get(report)
      .query({ ...blakeRange, projectId: BLAKE_PROJECT_ID });

    expect(JSON.stringify(res.body)).not.toMatch(/reef/i);
    if (res.status === 200) {
      const body = CategoryReport.parse(res.body);
      for (const month of body.months) {
        expect(month.totalMinor).toBe(0n);
        expect(month.categories.every((c) => c.totalMinor === 0n)).toBe(true);
      }
    } else {
      expectProblem(res, 404);
    }
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

  describe.each([
    ['the report', report],
    ['the drill-down', lines(ALICE_ACCOUNTS.groceries)],
  ])('%s', (_label, path) => {
    it.each(badDates)('rejects %s as from', async (_l, from) => {
      expectValidationProblem(await request(h.app).get(path).query({ from, to: '2026-06-30' }), 'from');
    });

    it.each(badDates)('rejects %s as to', async (_l, to) => {
      expectValidationProblem(await request(h.app).get(path).query({ from: '2026-01-01', to }), 'to');
    });

    it('requires from', async () => {
      expectValidationProblem(await request(h.app).get(path).query({ to: '2026-06-30' }), 'from');
    });

    it('requires to', async () => {
      expectValidationProblem(await request(h.app).get(path).query({ from: '2026-01-01' }), 'to');
    });

    it('rejects from after to, naming from', async () => {
      expectValidationProblem(
        await request(h.app).get(path).query({ from: '2026-05-20', to: '2026-05-10' }),
        'from',
      );
    });

    it(`rejects a period longer than ${MAX_REPORT_MONTHS} months, naming to`, async () => {
      expectValidationProblem(
        await request(h.app).get(path).query({ from: '2024-01-01', to: '2026-01-01' }),
        'to',
      );
      expectValidationProblem(
        await request(h.app).get(path).query({ from: '2000-01-01', to: '2026-01-01' }),
        'to',
      );
    });

    it(`accepts a period of exactly ${MAX_REPORT_MONTHS} calendar months`, async () => {
      const res = await request(h.app).get(path).query({ from: '2024-01-31', to: '2025-12-01' });
      expect(res.status).toBe(200);
    });
  });

  it('rejects a non-uuid projectId on the report', async () => {
    expectValidationProblem(
      await request(h.app).get(report).query({ ...PERIOD, projectId: 'not-a-uuid' }),
      'projectId',
    );
  });

  it.each([['not-a-uuid'], ['12345'], ['groceries']])(
    'rejects %s as a drill-down id, naming ledgerAccountId',
    async (id) => {
      expectValidationProblem(await request(h.app).get(lines(id)).query(PERIOD), 'ledgerAccountId');
    },
  );
});

describe('a first-of-the-month entry under a session TimeZone far from UTC', () => {
  let category: string;
  let dbName: string;
  const month = monthAt(-2);
  const previous = monthAt(-3);
  const firstOn = iso(dayOfMonth(month, 1));
  const lastOn = iso(monthEnd(month));
  const previousLastOn = iso(monthEnd(previous));

  beforeAll(async () => {
    category = await createExpenseCategory('Timezone Probe');
    for (const [occurredOn, amount] of [
      [firstOn, '-1111'],
      [lastOn, '-3333'],
      [previousLastOn, '-2222'],
    ] as const) {
      await postEntry({
        occurredOn,
        payee: `TZ ${occurredOn}`,
        accountId: ALICE_ACCOUNTS.checking,
        categoryId: category,
        amountMinor: amount,
      });
    }
    const [row] = await h.db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    dbName = row?.name ?? '';
    expect(dbName).not.toBe('');
  });

  const withTimeZone = async (zone: string, body: (t: Harness) => Promise<void>): Promise<void> => {
    const raw = await connectRaw();
    const quoted = `"${dbName.replaceAll('"', '""')}"`;
    try {
      await raw.query(`ALTER DATABASE ${quoted} SET timezone TO '${zone}'`);
      // A fresh pool: database-level settings apply to new connections only.
      const t = await startHarness();
      try {
        const [shown] = await t.db.$queryRaw<{ TimeZone: string }[]>`SHOW TimeZone`;
        expect(shown?.TimeZone).toBe(zone);
        await body(t);
      } finally {
        await t.close();
      }
    } finally {
      await raw.query(`ALTER DATABASE ${quoted} RESET timezone`);
      await raw.end();
    }
  };

  it.each([['Pacific/Kiritimati'], ['Etc/GMT+12']])(
    'keeps the 1st in its own month, and the last day in its own, under %s',
    async (zone) => {
      await withTimeZone(zone, async (t) => {
        const res = await request(t.app)
          .get(report)
          .query({ from: iso(previous), to: lastOn });
        expect(res.status).toBe(200);
        const body = CategoryReport.parse(res.body);

        expect(body.months.map((m) => m.month)).toEqual([ym(previous), ym(month)]);
        const total = (m: string): bigint | undefined =>
          monthOf(body, m).categories.find((c) => c.ledgerAccountId === category)?.totalMinor;
        expect(total(ym(month))).toBe(1_111n + 3_333n);
        expect(total(ym(previous))).toBe(2_222n);

        const drillRes = await request(t.app)
          .get(lines(category))
          .query({ from: firstOn, to: lastOn });
        expect(drillRes.status).toBe(200);
        const drill = CategoryLines.parse(drillRes.body);
        expect(drill.lines.map((l) => [l.occurredOn, l.amountMinor])).toEqual([
          [lastOn, 3_333n],
          [firstOn, 1_111n],
        ]);

        const edge = CategoryLines.parse(
          (await request(t.app).get(lines(category)).query({ from: previousLastOn, to: previousLastOn }))
            .body,
        );
        expect(edge.lines.map((l) => [l.occurredOn, l.amountMinor])).toEqual([
          [previousLastOn, 2_222n],
        ]);
      });
    },
  );

  it('restored the database TimeZone afterwards', async () => {
    const t = await startHarness();
    try {
      const [shown] = await t.db.$queryRaw<{ TimeZone: string }[]>`SHOW TimeZone`;
      expect(shown?.TimeZone).not.toBe('Pacific/Kiritimati');
      expect(shown?.TimeZone).not.toBe('Etc/GMT+12');
    } finally {
      await t.close();
    }
  });
});
