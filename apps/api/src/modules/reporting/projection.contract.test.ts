import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BalancesResponse,
  CategoryReport,
  MAX_PROJECTION_MONTHS,
  ProjectionResponse,
  TransactionPage,
  apiPath,
  routes,
  type OccurrenceGroup,
  type ScheduledOccurrenceView,
} from '@pfm/contracts';
import { seedId } from '../../../prisma/seed/ids.js';
import { addDays, addMonths, todayUtc } from '../../../prisma/seed/time.js';
import {
  ALICE,
  ALICE_ACCOUNTS,
  BLAKE,
  startHarness,
  type Harness,
} from '../../test/harness.js';
import { expectProblem, expectValidationProblem } from '../../test/problem.js';

// US4 — "store future bills and income and see a projection of the total
// balance". Every figure asserted here is derived independently: from the
// ledger rows themselves, from the `scheduled_occurrences` table, or from a
// before/after delta across one write. Nothing is compared against the
// endpoint's own output, and no money value passes through a JS `number`.
//
// The rule the whole story rests on: a scheduled occurrence is not an entry.
// It is in the projection and in nothing else.

const projection = apiPath(routes.projection);
const balances = apiPath(routes.accountBalances);
const entries = apiPath(routes.entries);
const categoryReport = apiPath(routes.categoryReport);

const iso = (value: Date): string => value.toISOString().slice(0, 10);
const asDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

const TODAY_DATE = todayUtc();
const TODAY = iso(TODAY_DATE);
const inDays = (days: number): string => iso(addDays(TODAY_DATE, days));
const inMonths = (months: number): string => iso(addMonths(TODAY_DATE, months));
const firstOfMonth = (day: string): string => `${day.slice(0, 7)}-01`;
const lastOfMonth = (day: string): string =>
  iso(new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)));

/** The seeded schedules — `prisma/seed/recurring.ts`, keyed the same way. */
const SERIES = {
  salary: seedId(`series:${ALICE}:salary`),
  rent: seedId(`series:${ALICE}:rent`),
  utilities: seedId(`series:${ALICE}:utilities`),
  fitness: seedId(`series:${ALICE}:fitness`),
  water: seedId(`series:${ALICE}:water-overdue`),
} as const;
const BLAKE_DOCK_FEES = seedId(`series:${BLAKE}:dock-fees`);

let h: Harness;

const getProjection = async (
  to: string,
  app: Server = h.app,
): Promise<ProjectionResponse> => {
  const res = await request(app).get(projection).query({ to });
  expect(res.status).toBe(200);
  return ProjectionResponse.parse(res.body);
};

/** The raw signed sum over asset and liability lines — `netWorthMinor`'s basis. */
const ledgerNetThrough = async (
  ownerId: string,
  to: string,
): Promise<bigint> => {
  const lines = await h.db.entryLine.findMany({
    where: {
      entry: { ownerId, occurredOn: { lte: asDate(to) } },
      ledgerAccount: { kind: { in: ['asset', 'liability'] } },
    },
    select: { amountMinor: true },
  });
  return lines.reduce((total, line) => total + line.amountMinor, 0n);
};

const occurrenceNet = async (
  ownerId: string,
  dueOn: { gte?: Date; lt?: Date; lte?: Date },
): Promise<bigint> => {
  const rows = await h.db.scheduledOccurrence.findMany({
    where: { materializedEntryId: null, series: { ownerId }, dueOn },
    select: { amountMinor: true },
  });
  return rows.reduce((total, row) => total + row.amountMinor, 0n);
};

const of = (
  group: OccurrenceGroup,
  seriesId: string,
): ScheduledOccurrenceView[] =>
  group.occurrences.filter((row) => row.seriesId === seriesId);

const netOf = (rows: readonly ScheduledOccurrenceView[]): bigint =>
  rows.reduce((total, row) => total + row.amountMinor, 0n);

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

// ---------------------------------------------------------------------------

describe('GET /projection — the response the contract describes', () => {
  it('echoes the server’s today as asOf and the horizon it was asked for', async () => {
    const to = inMonths(1);
    const body = await getProjection(to);

    expect(body.asOf).toBe(TODAY);
    expect(body.to).toBe(to);
  });

  it('reports the same netWorthMinor the balances panel shows', async () => {
    const body = await getProjection(inMonths(1));
    const panel = BalancesResponse.parse(
      (await request(h.app).get(balances)).body,
    );

    expect(panel.asOf).toBe(body.asOf);
    expect(body.netWorthMinor).toBe(panel.netWorthMinor);
    expect(body.netWorthMinor).toBe(await ledgerNetThrough(ALICE, TODAY));
  });

  it('carries today’s balance forward by what is scheduled, and by nothing else', async () => {
    const to = inMonths(3);
    const body = await getProjection(to);

    // Derived from the ledger and the occurrence table, not from the response.
    const ledger = await ledgerNetThrough(ALICE, to);
    const scheduled = await occurrenceNet(ALICE, {
      gte: asDate(TODAY),
      lte: asDate(to),
    });

    expect(body.scheduled.netMinor).toBe(scheduled);
    expect(body.projectedNetWorthMinor).toBe(ledger + scheduled);
  });

  it('leaves overdue out of the projected figure and carries it in its own group', async () => {
    const to = inMonths(3);
    const body = await getProjection(to);
    const overdue = await occurrenceNet(ALICE, { lt: asDate(TODAY) });

    expect(overdue).not.toBe(0n);
    expect(body.overdue.netMinor).toBe(overdue);
    expect(body.projectedNetWorthMinor).toBe(
      (await ledgerNetThrough(ALICE, to)) + body.scheduled.netMinor,
    );
    // Stated as a difference so the assertion fails if overdue were folded in.
    expect(body.projectedNetWorthMinor).not.toBe(
      (await ledgerNetThrough(ALICE, to)) + body.scheduled.netMinor + overdue,
    );
  });

  it('puts every occurrence in exactly one group, split at today', async () => {
    const to = inMonths(2);
    const body = await getProjection(to);

    for (const row of body.overdue.occurrences)
      expect(row.dueOn < TODAY).toBe(true);
    for (const row of body.scheduled.occurrences) {
      expect(row.dueOn >= TODAY).toBe(true);
      expect(row.dueOn <= to).toBe(true);
    }
    const ids = [
      ...body.overdue.occurrences.map((row) => row.id),
      ...body.scheduled.occurrences.map((row) => row.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries money as strings on the wire, never as JSON numbers', async () => {
    const res = await request(h.app)
      .get(projection)
      .query({ to: inMonths(1) });
    const body = res.body as Record<string, unknown>;

    expect(typeof body['netWorthMinor']).toBe('string');
    expect(typeof body['projectedNetWorthMinor']).toBe('string');
    for (const key of ['overdue', 'scheduled'] as const) {
      const group = body[key] as Record<string, unknown>;
      expect(typeof group['netMinor']).toBe('string');
      for (const row of group['occurrences'] as Record<string, unknown>[]) {
        expect(typeof row['amountMinor']).toBe('string');
      }
    }
    for (const point of body['series'] as Record<string, unknown>[]) {
      expect(typeof point['netWorthMinor']).toBe('string');
    }
  });
});

describe('the series — solid to today, dashed forward', () => {
  it('runs in date order, ends at the horizon, and marks the basis at asOf', async () => {
    const to = inMonths(2);
    const body = await getProjection(to);

    expect(body.series.length).toBeGreaterThan(0);
    for (let i = 1; i < body.series.length; i += 1) {
      expect((body.series[i]?.on ?? '') > (body.series[i - 1]?.on ?? '')).toBe(
        true,
      );
    }
    for (const point of body.series) {
      expect(point.on <= to).toBe(true);
      expect(point.basis).toBe(point.on <= body.asOf ? 'actual' : 'projected');
    }
  });

  it('meets today’s net worth at asOf and the projected figure at the horizon', async () => {
    const to = inMonths(2);
    const body = await getProjection(to);

    const atAsOf = body.series.find((point) => point.on === body.asOf);
    expect(atAsOf?.netWorthMinor).toBe(body.netWorthMinor);

    const last = body.series.at(-1);
    expect(last?.on).toBe(to);
    expect(last?.netWorthMinor).toBe(body.projectedNetWorthMinor);
  });
});

describe('the seeded bills, in the net-worth basis and never sign-flipped', () => {
  it('shows the rent bill with its account, its category and its rule', async () => {
    const to = inMonths(2);
    const body = await getProjection(to);
    const rent = of(body.scheduled, SERIES.rent);

    expect(rent.length).toBeGreaterThan(0);
    const first = rent[0] as ScheduledOccurrenceView;
    expect(first.payee).toBe('Harbor Apartments');
    expect(first.amountMinor).toBe(-165_000n);
    expect(first.rule).toEqual({ frequency: 'monthly', dayOfMonth: 1 });
    expect(first.dueOn.slice(8, 10)).toBe('01');
    expect(first.ledgerAccountId).toBe(ALICE_ACCOUNTS.checking);
    expect(first.ledgerAccountName).toBe('Everyday Checking');
    expect(first.categoryName).toBe('Rent');
  });

  it('keeps a gym charge on the credit card negative — more owed is less net worth', async () => {
    const body = await getProjection(inMonths(2));
    const fitness = of(body.scheduled, SERIES.fitness);

    expect(fitness.length).toBeGreaterThan(0);
    for (const row of fitness) {
      expect(row.amountMinor).toBe(-3_500n);
      expect(row.ledgerAccountId).toBe(ALICE_ACCOUNTS.visa);
      expect(row.ledgerAccountName).toBe('Visa Credit Card');
      expect(row.categoryName).toBe('Fitness');
    }
  });

  it('keeps income positive in the same basis, twice in a one-month horizon', async () => {
    const body = await getProjection(inMonths(1));
    const salary = of(body.scheduled, SERIES.salary);

    expect(salary.length).toBeGreaterThanOrEqual(2);
    for (const row of salary) {
      expect(row.amountMinor).toBe(242_990n);
      expect(row.rule).toEqual({ frequency: 'biweekly' });
      expect(row.categoryName).toBe('Salary');
      expect(row.ledgerAccountId).toBe(ALICE_ACCOUNTS.checking);
    }
    const dates = salary.map((row) => row.dueOn).sort();
    expect(
      Date.parse(`${dates[1]}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`),
    ).toBe(14 * 86_400_000);
    // Income raises the forecast above today's balance on its own account.
    expect(netOf(salary)).toBe(242_990n * BigInt(salary.length));
  });

  it('adds the same money to the forecast as the occurrence rows carry', async () => {
    const to = inMonths(1);
    const body = await getProjection(to);
    const listed = netOf(body.scheduled.occurrences);

    expect(body.scheduled.netMinor).toBe(listed);
    expect(body.projectedNetWorthMinor - body.netWorthMinor).toBe(
      listed +
        ((await ledgerNetThrough(ALICE, to)) -
          (await ledgerNetThrough(ALICE, TODAY))),
    );
  });
});

describe('a scheduled occurrence is not an entry', () => {
  const to = inMonths(2);

  it('is in no balance, at today or at any future date', async () => {
    const body = await getProjection(to);
    expect(body.scheduled.netMinor).not.toBe(0n);

    for (const asOf of [TODAY, inDays(1), to]) {
      const panel = BalancesResponse.parse(
        (await request(h.app).get(balances).query({ asOf })).body,
      );
      expect(panel.asOf).toBe(asOf);
      expect(panel.netWorthMinor).toBe(await ledgerNetThrough(ALICE, asOf));
    }

    // The distinguishing case: at the horizon the ledger and the forecast differ
    // by exactly what is scheduled, so a balance that counted occurrences would
    // already have failed above.
    const atHorizon = BalancesResponse.parse(
      (await request(h.app).get(balances).query({ asOf: to })).body,
    );
    expect(body.projectedNetWorthMinor - atHorizon.netWorthMinor).toBe(
      body.scheduled.netMinor,
    );
  });

  it('is on no register page', async () => {
    await getProjection(to);

    const res = await request(h.app)
      .get(entries)
      .query({
        accountId: ALICE_ACCOUNTS.checking,
        from: TODAY,
        to,
        limit: 200,
      });
    expect(res.status).toBe(200);
    const page = TransactionPage.parse(res.body);

    const real = await h.db.entry.count({
      where: {
        ownerId: ALICE,
        occurredOn: { gte: asDate(TODAY), lte: asDate(to) },
        lines: { some: { ledgerAccountId: ALICE_ACCOUNTS.checking } },
      },
    });
    expect(page.data).toHaveLength(real);
    expect(page.data.map((row) => row.payee)).not.toContain('Riverside Water');
    expect(page.data.map((row) => row.payee)).not.toContain(
      'Harbor Apartments',
    );
  });

  it('is in no category report, which still totals the real lines of the same month', async () => {
    const body = await getProjection(to);
    const rent = of(body.scheduled, SERIES.rent)[0];
    expect(rent).toBeDefined();
    const month = (rent as ScheduledOccurrenceView).dueOn;

    const from = firstOfMonth(TODAY);
    const until = lastOfMonth(month);
    const res = await request(h.app)
      .get(categoryReport)
      .query({ from, to: until });
    expect(res.status).toBe(200);
    const report = CategoryReport.parse(res.body);

    const forward = report.months.find(
      (row) => row.month === month.slice(0, 7),
    );
    expect(forward).toBeDefined();

    const lines = await h.db.entryLine.findMany({
      where: {
        entry: {
          ownerId: ALICE,
          occurredOn: {
            gte: asDate(firstOfMonth(month)),
            lte: asDate(lastOfMonth(month)),
          },
        },
        ledgerAccount: { kind: 'expense' },
        excludedFromReporting: false,
      },
      select: { amountMinor: true },
    });
    expect(forward?.totalMinor).toBe(
      lines.reduce((total, line) => total + line.amountMinor, 0n),
    );
    expect(
      forward?.categories.map((category) => category.totalMinor),
    ).not.toContain(165_000n);
  });

  it('holds no line in the ledger at all', async () => {
    await getProjection(to);
    const open = await h.db.scheduledOccurrence.count({
      where: { series: { ownerId: ALICE }, materializedEntryId: null },
    });
    expect(open).toBeGreaterThan(0);

    const payees = await h.db.entry.count({
      where: { ownerId: ALICE, payee: 'Riverside Water' },
    });
    expect(payees).toBe(0);
  });
});

describe('the overdue group', () => {
  it('holds the bill due before today that nothing paid, out of the forecast', async () => {
    const body = await getProjection(inMonths(1));
    const water = of(body.overdue, SERIES.water);

    expect(water).toHaveLength(1);
    const bill = water[0] as ScheduledOccurrenceView;
    expect(bill.payee).toBe('Riverside Water');
    expect(bill.amountMinor).toBe(-6_420n);
    expect(bill.rule).toEqual({ frequency: 'one-off' });
    expect(bill.dueOn < TODAY).toBe(true);

    expect(of(body.scheduled, SERIES.water)).toHaveLength(0);
    expect(body.overdue.netMinor).toBe(netOf(body.overdue.occurrences));
    expect(body.overdue.netMinor).toBeLessThan(0n);
  });

  it('does not move with the horizon — it is money that has not moved, not a forecast', async () => {
    const near = await getProjection(inDays(1));
    const far = await getProjection(inMonths(6));

    expect(far.overdue.netMinor).toBe(near.overdue.netMinor);
    expect(far.overdue.occurrences.map((row) => row.id).sort()).toEqual(
      near.overdue.occurrences.map((row) => row.id).sort(),
    );
  });

  it('answers a horizon already in the past with nothing scheduled, not an error', async () => {
    const body = await getProjection(inDays(-1));

    expect(body.scheduled.occurrences).toEqual([]);
    expect(body.scheduled.netMinor).toBe(0n);
    expect(body.overdue.occurrences.length).toBeGreaterThan(0);
  });
});

describe('tenancy — the forecast is one owner’s', () => {
  it('shows the demo tenant nothing of the decoy’s schedule', async () => {
    const to = inMonths(6);
    const raw = await request(h.app).get(projection).query({ to });
    expect(raw.status).toBe(200);
    const body = ProjectionResponse.parse(raw.body);
    const rows = [...body.overdue.occurrences, ...body.scheduled.occurrences];

    expect(rows.map((row) => row.seriesId)).not.toContain(BLAKE_DOCK_FEES);
    for (const row of rows) {
      expect(row.payee).not.toContain('REEF');
      expect(row.ledgerAccountName).not.toContain('Reef');
    }
    expect(JSON.stringify(raw.body)).not.toContain('REEF');
  });

  it('never lets one tenant’s expansion write rows under the other’s series', async () => {
    const before = await h.db.scheduledOccurrence.count({
      where: { series: { ownerId: BLAKE } },
    });

    await getProjection(inMonths(MAX_PROJECTION_MONTHS));

    expect(
      await h.db.scheduledOccurrence.count({
        where: { series: { ownerId: BLAKE } },
      }),
    ).toBe(before);
  });

  it('serves the decoy his own forecast, figured from his ledger alone', async () => {
    const asBlake = await h.as(BLAKE);
    const to = inMonths(2);
    const raw = await request(asBlake).get(projection).query({ to });
    expect(raw.status).toBe(200);
    const body = ProjectionResponse.parse(raw.body);

    expect(body.netWorthMinor).toBe(await ledgerNetThrough(BLAKE, TODAY));
    expect(body.projectedNetWorthMinor).toBe(
      (await ledgerNetThrough(BLAKE, to)) +
        (await occurrenceNet(BLAKE, { gte: asDate(TODAY), lte: asDate(to) })),
    );

    const rows = [...body.overdue.occurrences, ...body.scheduled.occurrences];
    expect(rows.map((row) => row.seriesId)).toContain(BLAKE_DOCK_FEES);
    for (const row of rows) {
      expect(Object.values(SERIES)).not.toContain(row.seriesId);
      expect(row.ledgerAccountName).not.toBe('Everyday Checking');
      expect(row.ledgerAccountName).not.toBe('Visa Credit Card');
    }
    expect(JSON.stringify(raw.body)).not.toContain('Harbor Apartments');

    const mine = await getProjection(to);
    expect(body.netWorthMinor).not.toBe(mine.netWorthMinor);
  });
});

describe('GET /projection — validation', () => {
  it('requires to, with no default horizon to fall back on', async () => {
    expectValidationProblem(await request(h.app).get(projection), 'to');
  });

  it.each([
    ['a non-date', 'soon'],
    ['an impossible date', '2027-02-30'],
    ['a month only', '2027-02'],
    ['a timestamp', '2027-02-01T00:00:00Z'],
    ['an empty string', ''],
  ])('rejects %s as to, naming it', async (_label, to) => {
    expectValidationProblem(
      await request(h.app).get(projection).query({ to }),
      'to',
    );
  });

  it(`accepts a horizon exactly ${MAX_PROJECTION_MONTHS} months out`, async () => {
    const to = inMonths(MAX_PROJECTION_MONTHS);
    const body = await getProjection(to);

    expect(body.to).toBe(to);
    expect(body.scheduled.occurrences.length).toBeGreaterThan(0);
  });

  it('refuses a horizon one day past the limit, naming it and the boundary date, and expands nothing', async () => {
    const limit = inMonths(MAX_PROJECTION_MONTHS);
    const past = iso(addDays(asDate(limit), 1));
    const before = await h.db.scheduledOccurrence.count({
      where: { series: { ownerId: ALICE } },
    });

    // An out-of-range query parameter, exactly as an over-long report period
    // is: 400, naming `to` in `errors`. The backdate bound is a rule about
    // schedules rather than a range on a parameter, and answers 422.
    const res = await request(h.app).get(projection).query({ to: past });
    const problem = expectValidationProblem(res, 'to');
    const said = `${problem.title} ${problem.detail ?? ''} ${JSON.stringify(
      problem.errors ?? [],
    )}`;
    expect(said).toContain(String(MAX_PROJECTION_MONTHS));
    expect(said).toContain(limit);

    expect(
      await h.db.scheduledOccurrence.count({
        where: { series: { ownerId: ALICE } },
      }),
    ).toBe(before);
    expect(
      await h.db.scheduledOccurrence.count({
        where: { series: { ownerId: ALICE }, dueOn: { gt: asDate(limit) } },
      }),
    ).toBe(0);
  });
});
