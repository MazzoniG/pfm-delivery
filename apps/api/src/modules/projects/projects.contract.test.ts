import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountBalanceResponse,
  CategoryReport,
  CorrectionResponse,
  Entry,
  LedgerAccount,
  LockedEntryProblem,
  MAX_REPORT_MONTHS,
  PROBLEM_CONTENT_TYPE,
  Project,
  ProjectInUseProblem,
  ProjectList,
  ProjectReport,
  TransactionPage,
  apiPath,
  routes,
  type CategoryTotal,
  type ProjectLine,
  type ProjectSummary,
  type TransactionRowView,
} from '@pfm/contracts';
import { buildDecoyTenant } from '../../../prisma/seed/decoy-tenant.js';
import { buildDemoTenant, type Tenant } from '../../../prisma/seed/demo-tenant.js';
import { seedId } from '../../../prisma/seed/ids.js';
import {
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
  BLAKE_PROJECT_ID,
  connectRaw,
  isoDaysAgo,
  reconcile,
  seededAccountId,
  seededEntryId,
  startHarness,
  todayIso,
  uniqueName,
  type Harness,
} from '../../test/harness.js';
import { expectProblem, expectValidationProblem } from '../../test/problem.js';

// US5 — "keep track of expenses that relate to particular projects". Seeded
// figures are derived from the seed builders' own drafts, summed in BigInt;
// everything else is posted here and asserted from what was posted. Nothing is
// compared against the endpoint's own output, and no amount passes through a JS
// `number`.

const projects = apiPath(routes.projects);
const project = (id: string): string => apiPath(routes.project(id));
const projectReport = (id: string): string => apiPath(routes.projectReport(id));
const entries = apiPath(routes.entries);
const entry = (id: string): string => apiPath(routes.entry(id));
const correction = (id: string): string => apiPath(routes.entryCorrection(id));
const categoryReport = apiPath(routes.categoryReport);

const iso = (value: Date): string => value.toISOString().slice(0, 10);
const ym = (value: string): string => value.slice(0, 7);

const TODAY_DATE = todayUtc();
const CURRENT = startOfMonth(TODAY_DATE);
/** Six whole months ending with the current one — what the report view sends. */
const PERIOD = {
  from: iso(addMonths(CURRENT, -5)),
  to: iso(dayOfMonth(CURRENT, daysInMonth(CURRENT))),
};

const NOBODY = '00000000-0000-4000-8000-0000000000ef';
const HOUSE = seedId(`project:${ALICE}:house-remodel`);
const FRANCE = seedId(`project:${ALICE}:france-trip`);
const HOME_IMPROVEMENT = seededAccountId(ALICE, 'home-improvement');
const FREELANCE = seededAccountId(ALICE, 'freelance');

// ---------------------------------------------------------------------------
// The seed, viewed as the contract describes it.

type SeedLine = {
  id: string;
  entryId: string;
  occurredOn: string;
  payee: string | null;
  ledgerAccountId: string;
  amountMinor: bigint;
  projectId: string | null;
  excluded: boolean;
};

const seedLinesOf = (tenant: Tenant): SeedLine[] => {
  const allEntries = [...tenant.entries, ...tenant.corrections.entries];
  const byId = new Map(allEntries.map((e) => [String(e.id), e]));
  return [...tenant.lines, ...tenant.corrections.lines].map((line) => {
    const owner = byId.get(String(line.entryId));
    return {
      id: String(line.id),
      entryId: String(line.entryId),
      occurredOn: iso(owner?.occurredOn as Date),
      payee: (owner?.payee as string | null | undefined) ?? null,
      ledgerAccountId: String(line.ledgerAccountId),
      amountMinor: BigInt(line.amountMinor as bigint),
      projectId: (line.projectId as string | null | undefined) ?? null,
      excluded: line.excludedFromReporting === true,
    };
  });
};

const alice = buildDemoTenant(ALICE, TODAY_DATE);
const blake = buildDecoyTenant(TODAY_DATE);
const ALICE_LINES = seedLinesOf(alice);
const BLAKE_LINES = seedLinesOf(blake);
const ACCOUNT = new Map(
  alice.accounts.map((a) => [String(a.id), { name: a.name, kind: String(a.kind) }]),
);
const kindOf = (id: string): string => ACCOUNT.get(id)?.kind ?? 'unknown';
const nameOf = (id: string): string => ACCOUNT.get(id)?.name ?? 'unknown';

type Figures = {
  netCostMinor: bigint;
  transactionCount: number;
  firstActivityOn: string | null;
  lastActivityOn: string | null;
};

/** `ProjectSummary`'s figures: raw signed sum, and excluded lines count for nothing. */
const figuresOf = (lines: readonly SeedLine[], projectId: string): Figures => {
  const counted = lines.filter((l) => l.projectId === projectId && !l.excluded);
  const dates = counted.map((l) => l.occurredOn).sort();
  return {
    netCostMinor: counted.reduce((total, l) => total + l.amountMinor, 0n),
    transactionCount: new Set(counted.map((l) => l.entryId)).size,
    firstActivityOn: dates[0] ?? null,
    lastActivityOn: dates.at(-1) ?? null,
  };
};

const byAmountDesc = (a: CategoryTotal, b: CategoryTotal): number =>
  a.totalMinor === b.totalMinor ? 0 : a.totalMinor > b.totalMinor ? -1 : 1;

const categoryTotals = (lines: readonly SeedLine[]): CategoryTotal[] => {
  const totals = new Map<string, bigint>();
  for (const l of lines) totals.set(l.ledgerAccountId, (totals.get(l.ledgerAccountId) ?? 0n) + l.amountMinor);
  return [...totals]
    .map(([ledgerAccountId, totalMinor]) => ({
      ledgerAccountId,
      name: nameOf(ledgerAccountId),
      totalMinor,
      includesCorrection: false,
    }))
    .sort(byAmountDesc);
};

const monthsIn = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let m = startOfMonth(new Date(`${from}T00:00:00.000Z`)); iso(m).slice(0, 7) <= ym(to); m = addMonths(m, 1)) {
    out.push(iso(m).slice(0, 7));
  }
  return out;
};

// ---------------------------------------------------------------------------
// HTTP helpers.

let h: Harness;

const post = async (body: Record<string, unknown>, app: Server = h.app): Promise<Entry> => {
  const res = await request(app).post(entries).send(body);
  expect([200, 201]).toContain(res.status);
  return Entry.parse(res.body);
};

const createProject = async (label: string, app: Server = h.app): Promise<Project> => {
  const res = await request(app).post(projects).send({ name: uniqueName(label) });
  expect(res.status).toBe(201);
  return Project.parse(res.body);
};

const listProjects = async (app: Server = h.app): Promise<ProjectSummary[]> => {
  const res = await request(app).get(projects);
  expect(res.status).toBe(200);
  return ProjectList.parse(res.body);
};

const summaryOf = async (id: string, app: Server = h.app): Promise<ProjectSummary> => {
  const found = (await listProjects(app)).find((p) => p.id === id);
  expect(found).toBeDefined();
  return found as ProjectSummary;
};

const figures = (s: ProjectSummary): Figures => ({
  netCostMinor: s.netCostMinor,
  transactionCount: s.transactionCount,
  firstActivityOn: s.firstActivityOn,
  lastActivityOn: s.lastActivityOn,
});

const getReport = async (
  id: string,
  query: Record<string, string> = PERIOD,
  app: Server = h.app,
): Promise<ProjectReport> => {
  const res = await request(app).get(projectReport(id)).query(query);
  expect(res.status).toBe(200);
  return ProjectReport.parse(res.body);
};

const getRegister = async (
  query: Record<string, string | number>,
): Promise<{ page: TransactionPage; raw: Record<string, unknown> }> => {
  const res = await request(h.app).get(entries).query(query);
  expect(res.status).toBe(200);
  return { page: TransactionPage.parse(res.body), raw: res.body as Record<string, unknown> };
};

const rowOf = (page: TransactionPage, entryId: string): TransactionRowView => {
  const row = page.data.find((r) => r.entryId === entryId);
  expect(row).toBeDefined();
  return row as TransactionRowView;
};

const freshAsset = async (label: string): Promise<string> => {
  const res = await request(h.app).post(apiPath(routes.accounts)).send({ name: uniqueName(label), kind: 'asset' });
  expect([200, 201]).toContain(res.status);
  return LedgerAccount.parse(res.body).id;
};

const sumLines = (lines: readonly ProjectLine[]): bigint =>
  lines.reduce((total, l) => total + l.amountMinor, 0n);

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

// ---------------------------------------------------------------------------

describe('GET /projects — the seeded projects, figured from the seed', () => {
  it('totals House remodel from its lines, the $200 split share included and the $30 left out', async () => {
    const house = await summaryOf(HOUSE);

    expect(house.name).toBe('House remodel');
    expect(figures(house)).toEqual(figuresOf(ALICE_LINES, HOUSE));

    // Pinned outright as well, so a seed change cannot move both sides at once:
    // 185.00 + 612.40 + 489.00 + the 200.00 of the Maple Street split.
    expect(house.netCostMinor).toBe(18_500n + 61_240n + 48_900n + 20_000n);
    expect(house.transactionCount).toBe(4);
    expect(house.lastActivityOn).toBe(iso(new Date(TODAY_DATE.getTime() - 3 * 86_400_000)));
  });

  it('totals France trip, whose spending sits in different months', async () => {
    const france = await summaryOf(FRANCE);

    expect(france.name).toBe('France trip');
    expect(figures(france)).toEqual(figuresOf(ALICE_LINES, FRANCE));
    expect(france.netCostMinor).toBe(21_400n + 96_000n + 7_850n + 6_200n);
    expect(ym(france.lastActivityOn ?? '')).not.toBe(ym(figuresOf(ALICE_LINES, HOUSE).lastActivityOn ?? ''));
  });

  it('counts the Household half of the Maple Street split toward no project', async () => {
    const split = ALICE_LINES.filter((l) => l.entryId === seededEntryId('split-hardware'));
    const household = split.find((l) => l.ledgerAccountId === ALICE_ACCOUNTS.household);
    expect(household?.projectId).toBeNull();

    const list = await listProjects();
    const net = list.reduce((total, p) => total + (p.id === HOUSE ? p.netCostMinor : 0n), 0n);
    expect(net).toBe(figuresOf(ALICE_LINES, HOUSE).netCostMinor);
    expect(net - 20_000n).toBe(18_500n + 61_240n + 48_900n);
  });

  it('carries money as strings on the wire', async () => {
    const res = await request(h.app).get(projects);
    const row = (res.body as Record<string, unknown>[]).find((p) => p['id'] === HOUSE);
    expect(typeof row?.['netCostMinor']).toBe('string');
  });

  it('sorts by most recent activity, then projects with none, newest created first', async () => {
    const older = await createProject('Empty older');
    await new Promise((resolve) => setTimeout(resolve, 15));
    const newer = await createProject('Empty newer');
    const active = await createProject('Active today');
    await post({
      occurredOn: todayIso(),
      payee: 'Sort probe',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.household,
      amountMinor: '-100',
      projectId: active.id,
    });

    const list = await listProjects();
    const at = (id: string): number => list.findIndex((p) => p.id === id);

    const firstIdle = list.findIndex((p) => p.lastActivityOn === null);
    const withActivity = firstIdle === -1 ? list : list.slice(0, firstIdle);
    const idle = firstIdle === -1 ? [] : list.slice(firstIdle);
    expect(idle.every((p) => p.lastActivityOn === null)).toBe(true);
    for (let i = 1; i < withActivity.length; i += 1) {
      expect((withActivity[i - 1]?.lastActivityOn ?? '') >= (withActivity[i]?.lastActivityOn ?? '')).toBe(true);
    }
    for (let i = 1; i < idle.length; i += 1) {
      expect(Date.parse(idle[i - 1]?.createdAt ?? '') >= Date.parse(idle[i]?.createdAt ?? '')).toBe(true);
    }

    expect(at(active.id)).toBeLessThan(at(HOUSE));
    expect(at(HOUSE)).toBeLessThan(at(FRANCE));
    expect(at(FRANCE)).toBeLessThan(at(newer.id));
    expect(at(newer.id)).toBeLessThan(at(older.id));

    const empty = list[at(older.id)];
    expect(empty?.netCostMinor).toBe(0n);
    expect(empty?.transactionCount).toBe(0);
    expect(empty?.firstActivityOn).toBeNull();
    expect(empty?.lastActivityOn).toBeNull();
  });
});

describe('GET /reports/projects/:id — the seeded House remodel', () => {
  const house = ALICE_LINES.filter((l) => l.projectId === HOUSE && !l.excluded);
  const inPeriod = house.filter(
    (l) => kindOf(l.ledgerAccountId) === 'expense' && l.occurredOn >= PERIOD.from && l.occurredOn <= PERIOD.to,
  );

  it('returns a gap-free month series of the project’s expense lines', async () => {
    const body = await getReport(HOUSE);

    expect(body.from).toBe(PERIOD.from);
    expect(body.to).toBe(PERIOD.to);
    expect(body.months.map((m) => m.month)).toEqual(monthsIn(PERIOD.from, PERIOD.to));
    for (const month of body.months) {
      const lines = inPeriod.filter((l) => ym(l.occurredOn) === month.month);
      expect(month.totalMinor).toBe(lines.reduce((t, l) => t + l.amountMinor, 0n));
      expect(month.categories).toEqual(categoryTotals(lines));
    }
  });

  it('totals the whole period by category, with the $30 Household line of the split absent', async () => {
    const body = await getReport(HOUSE);

    expect(body.categories).toEqual(categoryTotals(inPeriod));
    expect(body.categories.find((c) => c.ledgerAccountId === HOME_IMPROVEMENT)?.totalMinor).toBe(
      61_240n + 48_900n + 20_000n,
    );
    expect(body.categories.find((c) => c.ledgerAccountId === ALICE_ACCOUNTS.household)?.totalMinor).toBe(18_500n);
  });

  it('lists the project’s lines newest first, seen from the category, adding up to the net cost', async () => {
    const body = await getReport(HOUSE);
    const entryLines = (id: string): SeedLine[] => ALICE_LINES.filter((l) => l.entryId === id);

    const want = [...house]
      .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : 0))
      .map((l) => {
        const siblings = entryLines(l.entryId);
        const categoryLines = siblings.filter((s) => ['income', 'expense'].includes(kindOf(s.ledgerAccountId)));
        return {
          entryId: l.entryId,
          lineId: l.id,
          occurredOn: l.occurredOn,
          payee: l.payee,
          ledgerAccountId: l.ledgerAccountId,
          categoryName: nameOf(l.ledgerAccountId),
          accounts: siblings
            .filter((s) => ['asset', 'liability'].includes(kindOf(s.ledgerAccountId)))
            .map((s) => ({ ledgerAccountId: s.ledgerAccountId, name: nameOf(s.ledgerAccountId) })),
          amountMinor: l.amountMinor,
          entryTotalMinor:
            categoryLines.length > 1 ? categoryLines.reduce((t, s) => t + s.amountMinor, 0n) : null,
          reverses: null,
          reversedBy: null,
          replaces: null,
        };
      });

    expect(body.lines).toEqual(want);
    expect(body.linesTruncated).toBe(false);
    expect(sumLines(body.lines)).toBe(body.project.netCostMinor);
  });

  it('carries the split’s entry total beside its own share: 200.00 of 230.00', async () => {
    const body = await getReport(HOUSE);
    const split = body.lines.find((l) => l.entryId === seededEntryId('split-hardware'));

    expect(split?.amountMinor).toBe(20_000n);
    expect(split?.entryTotalMinor).toBe(23_000n);
    expect(split?.categoryName).toBe('Home Improvement');
    expect(split?.accounts).toEqual([{ ledgerAccountId: ALICE_ACCOUNTS.checking, name: 'Everyday Checking' }]);
    expect(body.lines.filter((l) => l.entryId === seededEntryId('split-hardware'))).toHaveLength(1);
  });

  it('embeds the same summary the list serves', async () => {
    const body = await getReport(HOUSE);
    expect(body.project).toEqual(await summaryOf(HOUSE));
  });

  it('restricts the charts to the period while the summary and lines stay whole-history', async () => {
    const last = figuresOf(ALICE_LINES, HOUSE).lastActivityOn ?? '';
    const period = { from: last, to: last };
    const body = await getReport(HOUSE, period);

    expect(body.months.map((m) => m.month)).toEqual([ym(last)]);
    expect(body.categories).toEqual([
      { ledgerAccountId: HOME_IMPROVEMENT, name: 'Home Improvement', totalMinor: 20_000n, includesCorrection: false },
    ]);
    expect(body.project.netCostMinor).toBe(figuresOf(ALICE_LINES, HOUSE).netCostMinor);
    expect(body.lines).toHaveLength(house.length);
  });
});

describe('GET /entries?projectId — the project seen through one account', () => {
  const houseEntries = new Set(ALICE_LINES.filter((l) => l.projectId === HOUSE).map((l) => l.entryId));
  const touching = (accountId: string): string[] =>
    [...houseEntries].filter((id) => ALICE_LINES.some((l) => l.entryId === id && l.ledgerAccountId === accountId));
  const share = (entryId: string): bigint =>
    ALICE_LINES.filter((l) => l.entryId === entryId && l.projectId === HOUSE).reduce((t, l) => t + l.amountMinor, 0n);

  it('keeps the project’s checking entries, each with its project share, and counts the rest', async () => {
    const { page } = await getRegister({ accountId: ALICE_ACCOUNTS.checking, projectId: HOUSE, limit: 200 });

    expect(page.data.map((r) => r.entryId).sort()).toEqual(touching(ALICE_ACCOUNTS.checking).sort());
    for (const row of page.data) expect(row.projectShareMinor).toBe(share(row.entryId));
    expect(page.projectEntriesInOtherAccounts).toBe(houseEntries.size - touching(ALICE_ACCOUNTS.checking).length);
  });

  it('shows the $230 split once, as −230.00 with a 200.00 project share', async () => {
    const { page } = await getRegister({ accountId: ALICE_ACCOUNTS.checking, projectId: HOUSE, limit: 200 });
    const rows = page.data.filter((r) => r.entryId === seededEntryId('split-hardware'));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.counterparty).toEqual({ kind: 'split' });
    expect(rows[0]?.amountMinor).toBe(-23_000n);
    expect(rows[0]?.projectShareMinor).toBe(20_000n);
  });

  it('shows a card charge with the liability’s display sign and the raw project share', async () => {
    const { page } = await getRegister({ accountId: ALICE_ACCOUNTS.visa, projectId: HOUSE, limit: 200 });

    expect(page.data.map((r) => r.entryId).sort()).toEqual(touching(ALICE_ACCOUNTS.visa).sort());
    const lumber = rowOf(page, seededEntryId('remodel-lumber'));
    // The card line is −612.40 raw; a liability flips once, at the DTO.
    expect(lumber.amountMinor).toBe(61_240n);
    expect(lumber.projectShareMinor).toBe(61_240n);
    expect(page.projectEntriesInOtherAccounts).toBe(houseEntries.size - touching(ALICE_ACCOUNTS.visa).length);
  });

  it('leaves both project fields absent, not null, without the filter', async () => {
    const { raw } = await getRegister({ accountId: ALICE_ACCOUNTS.checking, limit: 200 });

    expect(raw).not.toHaveProperty('projectEntriesInOtherAccounts');
    for (const row of raw['data'] as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty('projectShareMinor');
    }
  });

  it('carries money as strings on the wire under the filter', async () => {
    const { raw } = await getRegister({ accountId: ALICE_ACCOUNTS.checking, projectId: HOUSE });
    const rows = raw['data'] as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(typeof row['projectShareMinor']).toBe('string');
    expect(typeof raw['projectEntriesInOtherAccounts']).toBe('number');
  });

  it('sums every line of the entry assigned to the project, and only those', async () => {
    const account = await freshAsset('Split Share');
    const mine = await createProject('Apportioned');
    const theirs = await createProject('Other share');
    const created = await post({
      occurredOn: isoDaysAgo(4),
      payee: 'Multi-project split',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '7000', projectId: mine.id },
        { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '2000', projectId: mine.id },
        { ledgerAccountId: ALICE_ACCOUNTS.dining, amountMinor: '1500' },
        { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '500', projectId: theirs.id },
        { ledgerAccountId: account, amountMinor: '-11000' },
      ],
    });

    const forMine = rowOf((await getRegister({ accountId: account, projectId: mine.id })).page, created.id);
    expect(forMine.amountMinor).toBe(-11_000n);
    expect(forMine.counterparty).toEqual({ kind: 'split' });
    expect(forMine.projectShareMinor).toBe(9_000n);

    const forTheirs = rowOf((await getRegister({ accountId: account, projectId: theirs.id })).page, created.id);
    expect(forTheirs.projectShareMinor).toBe(500n);

    expect((await summaryOf(mine.id)).netCostMinor).toBe(9_000n);
    expect((await summaryOf(theirs.id)).netCostMinor).toBe(500n);

    const report = await getReport(mine.id);
    expect(report.lines.map((l) => l.entryTotalMinor)).toEqual([11_000n, 11_000n]);
  });

  it('carries the same other-accounts count on every page, across a date tie, without gaps', async () => {
    const account = await freshAsset('Paged Project');
    const p = await createProject('Paged');
    const ids: string[] = [];
    for (const [on, amount] of [[isoDaysAgo(3), '-100'], [isoDaysAgo(3), '-200'], [isoDaysAgo(2), '-300']] as const) {
      ids.push(
        (await post({ occurredOn: on, payee: 'Paged', accountId: account, categoryId: ALICE_ACCOUNTS.household, amountMinor: amount, projectId: p.id })).id,
      );
    }
    await post({ occurredOn: isoDaysAgo(2), payee: 'Elsewhere', accountId: ALICE_ACCOUNTS.visa, categoryId: ALICE_ACCOUNTS.household, amountMinor: '400', projectId: p.id });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: Record<string, string | number> = { accountId: account, projectId: p.id, limit: 1 };
      if (cursor !== null) query['cursor'] = cursor;
      const { page } = await getRegister(query);
      expect(page.projectEntriesInOtherAccounts).toBe(1);
      seen.push(...page.data.map((r) => r.entryId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('counts other-account entries inside from–to only, and ignores q and the cursor', async () => {
    const account = await freshAsset('Ranged Project');
    const p = await createProject('Ranged');
    const OLD = isoDaysAgo(30);
    const RECENT = isoDaysAgo(3);

    for (const [on, payee] of [[OLD, 'Ranged here old'], [RECENT, 'Ranged here new']] as const) {
      await post({ occurredOn: on, payee, accountId: account, categoryId: ALICE_ACCOUNTS.household, amountMinor: '-100', projectId: p.id });
    }
    // Two elsewhere on RECENT and one on OLD, so each range has its own count.
    for (const [on, payee] of [[OLD, 'Elsewhere old'], [RECENT, 'Elsewhere new'], [RECENT, 'Elsewhere new two']] as const) {
      await post({ occurredOn: on, payee, accountId: ALICE_ACCOUNTS.visa, categoryId: ALICE_ACCOUNTS.household, amountMinor: '-100', projectId: p.id });
    }

    const count = async (extra: Record<string, string | number> = {}): Promise<number | undefined> =>
      (await getRegister({ accountId: account, projectId: p.id, ...extra })).page.projectEntriesInOtherAccounts;

    expect(await count()).toBe(3);
    expect(await count({ from: RECENT, to: RECENT })).toBe(2);
    expect(await count({ from: OLD, to: OLD })).toBe(1);
    expect(await count({ from: RECENT })).toBe(2);
    expect(await count({ to: OLD })).toBe(1);
    expect(await count({ from: isoDaysAgo(20), to: isoDaysAgo(10) })).toBe(0);
    expect(await count({ from: isoDaysAgo(365), to: todayIso() })).toBe(3);

    // The payee search narrows the rows, never the count — whether it matches
    // this account's entries, only the other accounts' payees, or nothing.
    const searched = await getRegister({ accountId: account, projectId: p.id, q: 'Ranged here new' });
    expect(searched.page.data.map((r) => r.payee)).toEqual(['Ranged here new']);
    expect(searched.page.projectEntriesInOtherAccounts).toBe(3);
    expect(await count({ q: 'Elsewhere' })).toBe(3);
    expect(await count({ q: 'matches nothing at all' })).toBe(3);
    expect(await count({ q: 'Elsewhere', from: RECENT, to: RECENT })).toBe(2);

    // Every page of one listing carries the same figure, range applied.
    for (const range of [{}, { from: OLD, to: todayIso() }, { from: RECENT, to: RECENT }]) {
      const want = await count(range);
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: Record<string, string | number> = { accountId: account, projectId: p.id, limit: 1, ...range };
        if (cursor !== null) query['cursor'] = cursor;
        const { page } = await getRegister(query);
        expect(page.projectEntriesInOtherAccounts).toBe(want);
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);
      expect(pages).toBeGreaterThanOrEqual(1);
    }
  });

  it('rejects a non-uuid projectId, naming it', async () => {
    expectValidationProblem(
      await request(h.app).get(entries).query({ accountId: ALICE_ACCOUNTS.checking, projectId: 'house' }),
      'projectId',
    );
  });

  it('answers an unknown project with an empty page and a zero count, not a 404', async () => {
    const { page } = await getRegister({ accountId: ALICE_ACCOUNTS.checking, projectId: NOBODY });
    expect(page.data).toEqual([]);
    expect(page.projectEntriesInOtherAccounts).toBe(0);
  });
});

describe('exclusion inside a project', () => {
  it('drops excluded lines from every project figure, and from the lines that add up to it', async () => {
    const account = await freshAsset('Reimbursed');
    const p = await createProject('Client dinners');
    const counted = await post({
      occurredOn: isoDaysAgo(20),
      payee: 'Team lunch',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.dining, amountMinor: '4000', projectId: p.id },
        { ledgerAccountId: ALICE_ACCOUNTS.dining, amountMinor: '6000', projectId: p.id, excludedFromReporting: true },
        { ledgerAccountId: account, amountMinor: '-10000' },
      ],
    });
    // Later than the counted entry, and wholly excluded: it may not move the dates.
    const excluded = await post({
      occurredOn: isoDaysAgo(5),
      payee: 'Reimbursed in full',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '2500', projectId: p.id, excludedFromReporting: true },
        { ledgerAccountId: account, amountMinor: '-2500' },
      ],
    });

    const summary = await summaryOf(p.id);
    expect(figures(summary)).toEqual({
      netCostMinor: 4_000n,
      transactionCount: 1,
      firstActivityOn: isoDaysAgo(20),
      lastActivityOn: isoDaysAgo(20),
    });

    const report = await getReport(p.id);
    expect(report.categories).toEqual([
      { ledgerAccountId: ALICE_ACCOUNTS.dining, name: 'Dining', totalMinor: 4_000n, includesCorrection: false },
    ]);
    expect(report.months.find((m) => m.month === ym(isoDaysAgo(20)))?.totalMinor).toBe(4_000n);
    expect(report.months.find((m) => m.month === ym(isoDaysAgo(5)))?.categories.find(
      (c) => c.ledgerAccountId === ALICE_ACCOUNTS.household,
    )).toBeUndefined();
    expect(report.lines.map((l) => l.entryId)).not.toContain(excluded.id);
    expect(report.lines.map((l) => l.entryId)).toContain(counted.id);
    expect(sumLines(report.lines)).toBe(summary.netCostMinor);

    const spending = CategoryReport.parse(
      (await request(h.app).get(categoryReport).query({ ...PERIOD, projectId: p.id })).body,
    );
    const dining = spending.months.flatMap((m) => m.categories).filter((c) => c.ledgerAccountId === ALICE_ACCOUNTS.dining);
    expect(dining.reduce((t, c) => t + c.totalMinor, 0n)).toBe(4_000n);

    // An excluded line still moved real money.
    const balance = AccountBalanceResponse.parse((await request(h.app).get(apiPath(routes.accountBalance(account)))).body);
    expect(balance.balanceMinor).toBe(-12_500n);

    // What blocks a delete is every entry, excluded or not.
    const blocked = await request(h.app).delete(project(p.id));
    expectProblem(blocked, 409);
    expect(ProjectInUseProblem.parse(blocked.body).transactionCount).toBe(2);
  });
});

describe('sign convention — a refund, a card and an income line', () => {
  it('lowers the net cost by a refund booked to the project as income, and keeps it out of the chart', async () => {
    const p = await createProject('Refunded');
    const purchase = await post({
      occurredOn: isoDaysAgo(15),
      payee: 'Timberline Supply',
      lines: [
        { ledgerAccountId: HOME_IMPROVEMENT, amountMinor: '30000', projectId: p.id },
        { ledgerAccountId: ALICE_ACCOUNTS.visa, amountMinor: '-30000' },
      ],
    });
    // The simple form: +50.00 into checking, so the income line is −50.00.
    const refund = await post({
      occurredOn: isoDaysAgo(3),
      payee: 'Timberline Supply refund',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: FREELANCE,
      amountMinor: '5000',
      projectId: p.id,
    });

    const refundLines = new Map(refund.lines.map((l) => [l.ledgerAccountId, l]));
    expect(refundLines.get(FREELANCE)?.amountMinor).toBe(-5_000n);
    expect(refundLines.get(FREELANCE)?.projectId).toBe(p.id);
    expect(refundLines.get(ALICE_ACCOUNTS.checking)?.projectId).toBeNull();

    expect(figures(await summaryOf(p.id))).toEqual({
      netCostMinor: 25_000n,
      transactionCount: 2,
      firstActivityOn: isoDaysAgo(15),
      lastActivityOn: isoDaysAgo(3),
    });

    const report = await getReport(p.id);
    expect(report.categories).toEqual([
      { ledgerAccountId: HOME_IMPROVEMENT, name: 'Home Improvement', totalMinor: 30_000n, includesCorrection: false },
    ]);
    expect(report.months.flatMap((m) => m.categories).map((c) => c.ledgerAccountId)).not.toContain(FREELANCE);
    expect(report.lines.map((l) => [l.entryId, l.ledgerAccountId, l.amountMinor])).toEqual([
      [refund.id, FREELANCE, -5_000n],
      [purchase.id, HOME_IMPROVEMENT, 30_000n],
    ]);
    expect(report.lines[0]?.categoryName).toBe('Freelance');
    expect(report.lines[0]?.accounts).toEqual([{ ledgerAccountId: ALICE_ACCOUNTS.checking, name: 'Everyday Checking' }]);
    expect(report.lines[1]?.accounts).toEqual([{ ledgerAccountId: ALICE_ACCOUNTS.visa, name: 'Visa Credit Card' }]);
    expect(report.lines.map((l) => l.entryTotalMinor)).toEqual([null, null]);
    expect(sumLines(report.lines)).toBe(25_000n);

    const card = await getRegister({ accountId: ALICE_ACCOUNTS.visa, projectId: p.id });
    expect(rowOf(card.page, purchase.id).amountMinor).toBe(30_000n);
    expect(rowOf(card.page, purchase.id).projectShareMinor).toBe(30_000n);
    expect(card.page.projectEntriesInOtherAccounts).toBe(1);

    const bank = await getRegister({ accountId: ALICE_ACCOUNTS.checking, projectId: p.id });
    expect(rowOf(bank.page, refund.id).amountMinor).toBe(5_000n);
    expect(rowOf(bank.page, refund.id).projectShareMinor).toBe(-5_000n);
    expect(bank.page.projectEntriesInOtherAccounts).toBe(1);
  });
});

describe('project_id is meaningful only on income | expense lines — 422, exactly', () => {
  const expectDimensionRule = (res: Response): void => {
    const problem = expectProblem(res, 422);
    const said = `${problem.title} ${problem.detail ?? ''} ${JSON.stringify(problem.errors ?? [])}`.toLowerCase();
    expect(said).toContain('project');
    expect(said).toMatch(/income|expense/);
  };

  it.each([
    ['an asset', ALICE_ACCOUNTS.checking],
    ['a liability', ALICE_ACCOUNTS.visa],
    ['an equity', ALICE_ACCOUNTS.openingBalances],
  ])('refuses a projectId on %s line and writes nothing', async (_label, accountId) => {
    const p = await createProject('Misplaced');
    const before = await h.db.entry.count();

    const res = await request(h.app)
      .post(entries)
      .send({
        occurredOn: todayIso(),
        payee: 'Misplaced project',
        lines: [
          { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '1000' },
          { ledgerAccountId: accountId, amountMinor: '-1000', projectId: p.id },
        ],
      });

    expectDimensionRule(res);
    expect(await h.db.entry.count()).toBe(before);
    expect(await h.db.entryLine.count({ where: { projectId: p.id } })).toBe(0);
  });

  it('refuses it through PATCH of the lines, leaving them as they were', async () => {
    const p = await createProject('Misplaced patch');
    const created = await post({
      occurredOn: todayIso(),
      payee: 'Patch target',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.household,
      amountMinor: '-1000',
    });

    const res = await request(h.app)
      .patch(entry(created.id))
      .send({
        lines: [
          { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '1000' },
          { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-1000', projectId: p.id },
        ],
      });

    expectDimensionRule(res);
    const lines = await h.db.entryLine.findMany({ where: { entryId: created.id } });
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.projectId === null)).toBe(true);
  });

  it('refuses it in a correction’s replacement, and posts neither half', async () => {
    const p = await createProject('Misplaced correction');
    const filed = await post({
      occurredOn: isoDaysAgo(40),
      payee: 'Filed',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.household,
      amountMinor: '-1000',
    });
    await reconcile(h.db, filed.id);
    const before = await h.db.entry.count();

    const res = await request(h.app)
      .post(correction(filed.id))
      .send({
        replacement: {
          lines: [
            { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '1000' },
            { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-1000', projectId: p.id },
          ],
        },
      });

    expectDimensionRule(res);
    expect(await h.db.entry.count()).toBe(before);
  });

  it('lands the simple form’s projectId on the category line only', async () => {
    const p = await createProject('Simple form');
    const created = await post({
      occurredOn: todayIso(),
      payee: 'Simple with project',
      accountId: ALICE_ACCOUNTS.visa,
      categoryId: ALICE_ACCOUNTS.household,
      amountMinor: '-4200',
      projectId: p.id,
    });

    const byAccount = new Map(created.lines.map((l) => [l.ledgerAccountId, l]));
    expect(byAccount.get(ALICE_ACCOUNTS.household)?.projectId).toBe(p.id);
    expect(byAccount.get(ALICE_ACCOUNTS.household)?.amountMinor).toBe(4_200n);
    expect(byAccount.get(ALICE_ACCOUNTS.visa)?.projectId).toBeNull();
    expect((await summaryOf(p.id)).netCostMinor).toBe(4_200n);
  });

  it('rejects a non-uuid projectId on the simple form, naming it', async () => {
    expectValidationProblem(
      await request(h.app).post(entries).send({
        occurredOn: todayIso(),
        accountId: ALICE_ACCOUNTS.checking,
        categoryId: ALICE_ACCOUNTS.household,
        amountMinor: '-100',
        projectId: 'house',
      }),
    );
  });
});

describe('zero-sum holds for a split carrying projects', () => {
  it('rejects an unbalanced split through lines[] with a 400, and writes nothing', async () => {
    const p = await createProject('Unbalanced');
    const before = await h.db.entry.count();

    expectValidationProblem(
      await request(h.app)
        .post(entries)
        .send({
          occurredOn: todayIso(),
          payee: 'Unbalanced split',
          lines: [
            { ledgerAccountId: HOME_IMPROVEMENT, amountMinor: '20000', projectId: p.id },
            { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '3000' },
            { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-22000' },
          ],
        }),
      'lines',
    );
    expect(await h.db.entry.count()).toBe(before);
  });

  it('is refused by the deferred trigger at COMMIT when the API is bypassed', async () => {
    const p = await createProject('Trigger probe');
    const client = await connectRaw();
    let entryId = '';
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO entries (owner_id, occurred_on, payee) VALUES ($1, $2::date, 'Raw split') RETURNING id`,
        [ALICE, isoDaysAgo(1)],
      );
      entryId = inserted.rows[0]?.id ?? '';
      await client.query(
        `INSERT INTO entry_lines (entry_id, ledger_account_id, amount_minor, project_id)
         VALUES ($1, $2, 20000, $4), ($1, $3, -19999, NULL)`,
        [entryId, HOME_IMPROVEMENT, ALICE_ACCOUNTS.checking, p.id],
      );
      await expect(client.query('COMMIT')).rejects.toThrow();
    } finally {
      await client.end();
    }

    expect(await h.db.entry.findUnique({ where: { id: entryId } })).toBeNull();
    expect(figures(await summaryOf(p.id)).netCostMinor).toBe(0n);
  });
});

describe('corrections keep the project honest', () => {
  it('returns the project to zero when a filed project expense is corrected off it', async () => {
    const p = await createProject('Corrected away');
    const filed = await post({
      occurredOn: isoDaysAgo(40),
      payee: 'Wrong project',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.household,
      amountMinor: '-20000',
      projectId: p.id,
    });
    await reconcile(h.db, filed.id);
    expect((await summaryOf(p.id)).netCostMinor).toBe(20_000n);

    const res = await request(h.app)
      .post(correction(filed.id))
      .send({
        replacement: {
          payee: 'No project after all',
          accountId: ALICE_ACCOUNTS.checking,
          categoryId: ALICE_ACCOUNTS.household,
          amountMinor: '-20000',
        },
      });
    expect([200, 201]).toContain(res.status);
    const { reversal, replacement } = CorrectionResponse.parse(res.body);

    // Had the reversal dropped project_id, this would still read 200.00.
    const summary = await summaryOf(p.id);
    expect(summary.netCostMinor).toBe(0n);
    expect(summary.transactionCount).toBe(2);
    expect(summary.lastActivityOn).toBe(todayIso());

    const report = await getReport(p.id);
    expect(report.lines.map((l) => l.entryId).sort()).toEqual([filed.id, reversal.id].sort());
    expect(report.lines.map((l) => l.entryId)).not.toContain(replacement.id);
    const reversed = report.lines.find((l) => l.entryId === reversal.id);
    expect(reversed?.amountMinor).toBe(-20_000n);
    expect(reversed?.occurredOn).toBe(todayIso());
    expect(reversed?.reverses?.id).toBe(filed.id);
    expect(report.lines.find((l) => l.entryId === filed.id)?.reversedBy?.id).toBe(reversal.id);
    expect(sumLines(report.lines)).toBe(0n);
    const current = report.months.find((m) => m.month === ym(todayIso()));
    expect(current?.categories.find((c) => c.ledgerAccountId === ALICE_ACCOUNTS.household)?.includesCorrection).toBe(true);
  });

  it('answers 409 to editing a reconciled split, and takes the new split through the correction', async () => {
    const p = await createProject('Resplit');
    const filed = await post({
      occurredOn: isoDaysAgo(40),
      payee: 'Maple Street Hardware',
      lines: [
        { ledgerAccountId: HOME_IMPROVEMENT, amountMinor: '20000', projectId: p.id },
        { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '3000' },
        { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-23000' },
      ],
    });
    const lockedAt = await reconcile(h.db, filed.id);
    const resplit = [
      { ledgerAccountId: HOME_IMPROVEMENT, amountMinor: '18000', projectId: p.id },
      { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '5000' },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-23000' },
    ];

    const refused = await request(h.app).patch(entry(filed.id)).send({ lines: resplit });
    expect(refused.status).toBe(409);
    expect(refused.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const problem = LockedEntryProblem.parse(refused.body);
    expect(Date.parse(problem.lockedAt)).toBe(lockedAt.getTime());
    expect((await summaryOf(p.id)).netCostMinor).toBe(20_000n);

    const res = await request(h.app).post(correction(filed.id)).send({ replacement: { payee: 'Maple Street Hardware', lines: resplit } });
    expect([200, 201]).toContain(res.status);
    const { reversal, replacement } = CorrectionResponse.parse(res.body);
    expect(reversal.lines.find((l) => l.ledgerAccountId === HOME_IMPROVEMENT)?.projectId).toBe(p.id);

    expect((await summaryOf(p.id)).netCostMinor).toBe(18_000n);
    const { page } = await getRegister({ accountId: ALICE_ACCOUNTS.checking, projectId: p.id });
    expect(rowOf(page, filed.id).projectShareMinor).toBe(20_000n);
    expect(rowOf(page, reversal.id).projectShareMinor).toBe(-20_000n);
    expect(rowOf(page, replacement.id).projectShareMinor).toBe(18_000n);
  });
});

describe('POST /projects', () => {
  it('creates a project, trimming the name', async () => {
    const name = uniqueName('Kitchen');
    const res = await request(h.app).post(projects).send({ name: `  ${name}  ` });

    expect(res.status).toBe(201);
    const created = Project.parse(res.body);
    expect(created.name).toBe(name);
    expect((await summaryOf(created.id)).name).toBe(name);
  });

  it('accepts a name of exactly 80 characters', async () => {
    const name = uniqueName('Long').padEnd(80, 'x');
    const res = await request(h.app).post(projects).send({ name });
    expect(res.status).toBe(201);
    expect(Project.parse(res.body).name).toBe(name);
  });

  it.each([
    ['a missing name', {}],
    ['an empty name', { name: '' }],
    ['a whitespace-only name', { name: '   ' }],
    ['a name over 80 characters', { name: 'x'.repeat(81) }],
    ['a numeric name', { name: 42 }],
    ['a null name', { name: null }],
  ])('rejects %s with a 400 naming the field, and creates nothing', async (_label, body) => {
    const before = await h.db.project.count({ where: { ownerId: ALICE } });
    expectValidationProblem(await request(h.app).post(projects).send(body), 'name');
    expect(await h.db.project.count({ where: { ownerId: ALICE } })).toBe(before);
  });

  it('answers a duplicate name with a 409, trimmed or not', async () => {
    const first = await createProject('Duplicate');

    expectProblem(await request(h.app).post(projects).send({ name: first.name }), 409);
    expectProblem(await request(h.app).post(projects).send({ name: ` ${first.name} ` }), 409);
    expect(await h.db.project.count({ where: { ownerId: ALICE, name: first.name } })).toBe(1);
  });

  it('compares names case-sensitively: "Kitchen" and "kitchen" coexist, an exact repeat is a 409', async () => {
    const suffix = uniqueName('').trim();
    const upper = await request(h.app).post(projects).send({ name: `Kitchen ${suffix}` });
    expect(upper.status).toBe(201);
    const lower = await request(h.app).post(projects).send({ name: `kitchen ${suffix}` });
    expect(lower.status).toBe(201);
    expect(Project.parse(lower.body).id).not.toBe(Project.parse(upper.body).id);

    expectProblem(await request(h.app).post(projects).send({ name: `kitchen ${suffix}` }), 409);
    expectProblem(await request(h.app).post(projects).send({ name: `Kitchen ${suffix}` }), 409);

    // A rename that differs only in case is a different name, not a collision.
    const renamed = await request(h.app)
      .patch(project(Project.parse(lower.body).id))
      .send({ name: `KITCHEN ${suffix}` });
    expect(renamed.status).toBe(200);
    expectProblem(
      await request(h.app).patch(project(Project.parse(renamed.body).id)).send({ name: `Kitchen ${suffix}` }),
      409,
    );
  });

  it('answers the seeded name with a 409', async () => {
    expectProblem(await request(h.app).post(projects).send({ name: 'House remodel' }), 409);
  });

  it('lets another owner use the same name — unique per owner, and no hint that it exists', async () => {
    const mine = await createProject('Shared name');
    const asBlake = await h.as(BLAKE);

    const res = await request(asBlake).post(projects).send({ name: mine.name });
    expect(res.status).toBe(201);
    const theirs = Project.parse(res.body);
    expect(theirs.id).not.toBe(mine.id);

    expect(await request(asBlake).delete(project(theirs.id))).toHaveProperty('status', 204);
  });
});

describe('PATCH /projects/:id', () => {
  it('renames, keeping the id and creation time', async () => {
    const p = await createProject('Before');
    const name = uniqueName('After');

    const res = await request(h.app).patch(project(p.id)).send({ name });
    expect(res.status).toBe(200);
    const renamed = Project.parse(res.body);
    expect(renamed).toEqual({ ...p, name });
    expect((await summaryOf(p.id)).name).toBe(name);
  });

  it('accepts its own name back', async () => {
    const p = await createProject('Same');
    const res = await request(h.app).patch(project(p.id)).send({ name: p.name });
    expect(res.status).toBe(200);
    expect(Project.parse(res.body).name).toBe(p.name);
  });

  it('answers a rename onto another project’s name with a 409, and renames nothing', async () => {
    const a = await createProject('Taken');
    const b = await createProject('Taker');

    expectProblem(await request(h.app).patch(project(b.id)).send({ name: a.name }), 409);
    expect((await summaryOf(b.id)).name).toBe(b.name);
  });

  it.each([
    ['a missing name', {}],
    ['an empty name', { name: '' }],
    ['a whitespace-only name', { name: '  ' }],
    ['a name over 80 characters', { name: 'y'.repeat(81) }],
  ])('rejects %s with a 400 naming the field', async (_label, body) => {
    const p = await createProject('Validated');
    expectValidationProblem(await request(h.app).patch(project(p.id)).send(body), 'name');
    expect((await summaryOf(p.id)).name).toBe(p.name);
  });

  it.each([['not-a-uuid'], ['12345'], ['house-remodel']])('rejects %s as an id, naming it', async (id) => {
    expectValidationProblem(await request(h.app).patch(project(id)).send({ name: 'Anything' }), 'id');
  });

  it('answers 404 for an id that does not exist', async () => {
    expectProblem(await request(h.app).patch(project(NOBODY)).send({ name: uniqueName('Ghost') }), 404);
  });
});

describe('DELETE /projects/:id', () => {
  it('deletes an unused project with a 204, after which it is gone everywhere', async () => {
    const p = await createProject('Unused');

    const res = await request(h.app).delete(project(p.id));
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    expect((await listProjects()).map((row) => row.id)).not.toContain(p.id);
    expectProblem(await request(h.app).get(projectReport(p.id)).query(PERIOD), 404);
    expectProblem(await request(h.app).delete(project(p.id)), 404);
  });

  it('refuses a project lines still reference with a 409 carrying the count, and keeps it', async () => {
    const p = await createProject('In use');
    const posted: string[] = [];
    for (const amount of ['-1000', '-2000', '-3000']) {
      posted.push(
        (await post({ occurredOn: isoDaysAgo(6), payee: 'In use', accountId: ALICE_ACCOUNTS.checking, categoryId: ALICE_ACCOUNTS.household, amountMinor: amount, projectId: p.id })).id,
      );
    }

    const res = await request(h.app).delete(project(p.id));
    expectProblem(res, 409);
    const problem = ProjectInUseProblem.parse(res.body);
    expect(problem.transactionCount).toBe(3);
    expect(problem.detail).toContain('3');
    expect((await listProjects()).map((row) => row.id)).toContain(p.id);

    // Once nothing references it, the same delete succeeds.
    for (const id of posted) expect((await request(h.app).delete(entry(id))).status).toBe(204);
    expect((await request(h.app).delete(project(p.id))).status).toBe(204);
  });

  it('refuses the seeded House remodel, counting all four entries', async () => {
    const res = await request(h.app).delete(project(HOUSE));
    expectProblem(res, 409);
    expect(ProjectInUseProblem.parse(res.body).transactionCount).toBe(4);
  });

  it.each([['not-a-uuid'], ['12345']])('rejects %s as an id, naming it', async (id) => {
    expectValidationProblem(await request(h.app).delete(project(id)), 'id');
  });

  it('answers 404 for an id that does not exist', async () => {
    expectProblem(await request(h.app).delete(project(NOBODY)), 404);
  });
});

describe('GET /reports/projects/:id — errors', () => {
  it.each([['not-a-uuid'], ['12345'], ['house-remodel']])('rejects %s as an id, naming it', async (id) => {
    expectValidationProblem(await request(h.app).get(projectReport(id)).query(PERIOD), 'id');
  });

  it('answers 404 for an id that does not exist', async () => {
    expectProblem(await request(h.app).get(projectReport(NOBODY)).query(PERIOD), 404);
  });

  it('answers 404 for a ledger account id — a project id is not a category id', async () => {
    expectProblem(await request(h.app).get(projectReport(HOME_IMPROVEMENT)).query(PERIOD), 404);
  });

  const badDates: [string, string][] = [
    ['a non-date', 'yesterday'],
    ['an impossible date', '2026-02-30'],
    ['an empty string', ''],
    ['a month only', '2026-05'],
    ['a timestamp', '2026-05-01T00:00:00Z'],
  ];

  it.each(badDates)('rejects %s as from', async (_label, from) => {
    expectValidationProblem(await request(h.app).get(projectReport(HOUSE)).query({ from, to: '2026-06-30' }), 'from');
  });

  it.each(badDates)('rejects %s as to', async (_label, to) => {
    expectValidationProblem(await request(h.app).get(projectReport(HOUSE)).query({ from: '2026-01-01', to }), 'to');
  });

  it('requires from and to', async () => {
    expectValidationProblem(await request(h.app).get(projectReport(HOUSE)).query({ to: '2026-06-30' }), 'from');
    expectValidationProblem(await request(h.app).get(projectReport(HOUSE)).query({ from: '2026-01-01' }), 'to');
    expectValidationProblem(await request(h.app).get(projectReport(HOUSE)));
  });

  it('rejects from after to, naming from', async () => {
    expectValidationProblem(await request(h.app).get(projectReport(HOUSE)).query({ from: '2026-05-20', to: '2026-05-10' }), 'from');
  });

  it(`rejects a period longer than ${MAX_REPORT_MONTHS} months, naming to`, async () => {
    expectValidationProblem(await request(h.app).get(projectReport(HOUSE)).query({ from: '2024-01-01', to: '2026-01-01' }), 'to');
  });

  it(`accepts a period of exactly ${MAX_REPORT_MONTHS} calendar months`, async () => {
    const res = await request(h.app).get(projectReport(HOUSE)).query({ from: '2024-01-31', to: '2025-12-01' });
    expect(res.status).toBe(200);
    expect(ProjectReport.parse(res.body).months).toHaveLength(MAX_REPORT_MONTHS);
  });
});

describe('the decoy tenant’s project, from its own side', () => {
  it('serves Blake his project, figured from his seed alone', async () => {
    const asBlake = await h.as(BLAKE);
    const list = await listProjects(asBlake);

    expect(list.map((p) => p.id)).toEqual([BLAKE_PROJECT_ID]);
    expect(list[0]?.name).toBe('Reef tank');
    expect(figures(list[0] as ProjectSummary)).toEqual(figuresOf(BLAKE_LINES, BLAKE_PROJECT_ID));
    expect(list[0]?.netCostMinor).toBe(222_222n + 444_444n);

    const report = await getReport(BLAKE_PROJECT_ID, PERIOD, asBlake);
    expect(sumLines(report.lines)).toBe(222_222n + 444_444n);
    for (const line of report.lines) expect(line.payee).toContain('REEF');
  });
});
