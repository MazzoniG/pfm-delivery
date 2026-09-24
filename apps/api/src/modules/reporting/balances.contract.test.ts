import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNT_KINDS,
  AccountBalanceResponse,
  AccountList,
  BalancesResponse,
  LedgerAccount,
  apiPath,
  routes,
} from '@pfm/contracts';
import type { LedgerAccountKind } from '@prisma/client';
import { buildDemoTenant } from '../../../prisma/seed/demo-tenant.js';
import { todayUtc } from '../../../prisma/seed/time.js';
import {
  ALICE,
  ALICE_ACCOUNTS,
  BLAKE,
  BLAKE_ACCOUNTS,
  isoDaysAgo,
  startHarness,
  uniqueName,
  type Harness,
} from '../../test/harness.js';
import { expectProblem, expectValidationProblem } from '../../test/problem.js';

// US2 — "the balance for each account in real-time or at any point in time I
// choose". Every figure asserted here is derived from the seed's own inputs
// plus whatever rows the rest of the suite added, summed independently in
// BigInt. Nothing is compared against the endpoint's own output, and no money
// value passes through a JS `number` at any point.

const balances = apiPath(routes.accountBalances);
const balance = (id: string): string => apiPath(routes.accountBalance(id));
const accounts = apiPath(routes.accounts);
const entries = apiPath(routes.entries);

const iso = (value: Date | string): string =>
  typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);

const asDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

const TODAY = iso(todayUtc());
const daysFromToday = (days: number): string =>
  iso(new Date(todayUtc().getTime() + days * 86_400_000));

/** ARCHITECTURE §4 — debit positive, credit negative; flip once at the DTO. */
const displaySign = (kind: LedgerAccountKind): bigint =>
  kind === 'asset' || kind === 'expense' ? 1n : -1n;

// The seed builder is the seed's input, re-run here with the same anchor the
// seeder used. Re-deriving from it keeps the expected figures correct when the
// seed changes, which a hardcoded literal would not.
const seed = buildDemoTenant(ALICE, todayUtc());
const seedEntries = [...seed.entries, ...seed.corrections.entries];
const seedLines = [...seed.lines, ...seed.corrections.lines];
const seedEntryIds = seedEntries.map((entry) => String(entry.id));
const seedDate = new Map(
  seedEntries.map((entry) => [String(entry.id), iso(entry.occurredOn as Date)]),
);

type Expected = {
  raw: Map<string, bigint>;
  display: Map<string, bigint>;
  archived: Map<string, boolean>;
  subtotals: { asset: bigint; liability: bigint };
  netWorth: bigint;
  /** How much of the expectation came from the seed's own drafts. */
  seedLines: number;
};

const add = (into: Map<string, bigint>, key: string, amount: bigint): void => {
  into.set(key, (into.get(key) ?? 0n) + amount);
};

let h: Harness;

/**
 * Expected balances at `asOf`, assembled from the seed's drafts plus every row
 * this suite (or an earlier file) posted. The two halves are kept apart so the
 * seed half stays load-bearing rather than decorative.
 */
const expected = async (asOf: string): Promise<Expected> => {
  const raw = new Map<string, bigint>();
  let counted = 0;

  for (const line of seedLines) {
    const on = seedDate.get(String(line.entryId));
    if (on === undefined || on > asOf) continue;
    add(raw, String(line.ledgerAccountId), BigInt(line.amountMinor as bigint));
    counted += 1;
  }

  const extra = await h.db.entryLine.findMany({
    where: {
      entryId: { notIn: seedEntryIds },
      entry: { ownerId: ALICE, occurredOn: { lte: asDate(asOf) } },
    },
    select: { ledgerAccountId: true, amountMinor: true },
  });
  for (const line of extra) {
    add(raw, line.ledgerAccountId, line.amountMinor);
  }

  const ledgerAccounts = await h.db.ledgerAccount.findMany({
    where: { ownerId: ALICE, kind: { in: ['asset', 'liability'] } },
    select: { id: true, kind: true, archivedAt: true },
  });

  const display = new Map<string, bigint>();
  const archived = new Map<string, boolean>();
  const subtotals = { asset: 0n, liability: 0n };
  let netWorth = 0n;

  for (const account of ledgerAccounts) {
    const rawBalance = raw.get(account.id) ?? 0n;
    const shown = rawBalance * displaySign(account.kind);
    display.set(account.id, shown);
    archived.set(account.id, account.archivedAt !== null);
    subtotals[account.kind === 'asset' ? 'asset' : 'liability'] += shown;
    netWorth += rawBalance;
  }

  return { raw, display, archived, subtotals, netWorth, seedLines: counted };
};

const getBalances = async (
  app = h.app,
  query: Record<string, string> = {},
): Promise<BalancesResponse> => {
  const res = await request(app).get(balances).query(query);
  expect(res.status).toBe(200);
  return BalancesResponse.parse(res.body);
};

const rawBody = async (
  path: string,
  query: Record<string, string> = {},
): Promise<Record<string, unknown>> => {
  const res = await request(h.app).get(path).query(query);
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>;
};

const createAccount = async (
  kind: 'asset' | 'liability',
  label: string,
): Promise<string> => {
  const res = await request(h.app)
    .post(accounts)
    .send({ name: uniqueName(label), kind });
  expect([200, 201]).toContain(res.status);
  return LedgerAccount.parse(res.body).id;
};

const postEntry = async (body: Record<string, unknown>): Promise<string> => {
  const res = await request(h.app).post(entries).send(body);
  expect([200, 201]).toContain(res.status);
  return (res.body as { id: string }).id;
};

/**
 * A future-dated entry, written straight to the database: US2's rule is what a
 * balance does with one, and routing it through the create endpoint would make
 * this test fail for a reason that belongs to another story. The deferrable
 * zero-sum trigger still fires at COMMIT.
 */
const postFutureEntry = async (
  occurredOn: string,
  lines: readonly { ledgerAccountId: string; amountMinor: bigint }[],
): Promise<void> => {
  await h.db.$transaction(async (tx) => {
    const entry = await tx.entry.create({
      data: {
        ownerId: ALICE,
        occurredOn: asDate(occurredOn),
        payee: 'Future dated',
      },
      select: { id: true },
    });
    await tx.entryLine.createMany({
      data: lines.map((line) => ({ ...line, entryId: entry.id })),
    });
  });
};

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

describe('the seed this test derives from is the seed in the database', () => {
  it('finds every drafted seed entry, so the derived figures are not vacuous', async () => {
    const present = await h.db.entry.count({
      where: { id: { in: seedEntryIds } },
    });

    expect(seedEntryIds.length).toBeGreaterThan(0);
    expect(present).toBe(seedEntryIds.length);
  });
});

describe('GET /accounts/balances — shape and routing', () => {
  it('serves the literal path as a balances document, never as an account id', async () => {
    const res = await request(h.app).get(balances);

    expect(res.status).toBe(200);
    const body = BalancesResponse.parse(res.body);
    expect(Array.isArray(body.accounts)).toBe(true);
    // A `:id` match would have produced a uuid validation problem instead.
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('puts every money figure on the wire as a string', async () => {
    const body = await rawBody(balances);
    const rows = body['accounts'] as Record<string, unknown>[];

    expect(typeof body['netWorthMinor']).toBe('string');
    expect(body['netWorthMinor']).toMatch(/^-?\d+$/);

    const subtotals = body['subtotals'] as Record<string, unknown>;
    for (const kind of ACCOUNT_KINDS) {
      expect(typeof subtotals[kind]).toBe('string');
      expect(subtotals[kind]).toMatch(/^-?\d+$/);
    }

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row['balanceMinor']).toBe('string');
      expect(row['balanceMinor']).toMatch(/^-?\d+$/);
      expect(typeof row['archived']).toBe('boolean');
    }
  });

  it('exposes only the asset | liability window onto ledger_accounts', async () => {
    const body = await getBalances();
    const ids = body.accounts.map((row) => row.ledgerAccountId);

    for (const row of body.accounts) {
      expect(ACCOUNT_KINDS).toContain(row.kind);
    }
    expect(ids).toContain(ALICE_ACCOUNTS.checking);
    expect(ids).toContain(ALICE_ACCOUNTS.visa);
    expect(ids).not.toContain(ALICE_ACCOUNTS.salary);
    expect(ids).not.toContain(ALICE_ACCOUNTS.groceries);
    expect(ids).not.toContain(ALICE_ACCOUNTS.openingBalances);
  });

  it('returns a row for every asset and liability account the owner has', async () => {
    const body = await getBalances();
    const owned = await h.db.ledgerAccount.findMany({
      where: { ownerId: ALICE, kind: { in: ['asset', 'liability'] } },
      select: { id: true },
    });

    expect(new Set(body.accounts.map((row) => row.ledgerAccountId))).toEqual(
      new Set(owned.map((row) => row.id)),
    );
    expect(body.accounts).toHaveLength(owned.length);
  });
});

describe('at any point in time I choose', () => {
  it('resolves an absent asOf to the server’s UTC date and echoes it back', async () => {
    const body = await getBalances();

    expect(body.asOf).toBe(TODAY);
  });

  it('echoes the asOf it was given rather than today', async () => {
    const past = isoDaysAgo(90);
    const body = await getBalances(h.app, { asOf: past });

    expect(body.asOf).toBe(past);
    expect(body.asOf).not.toBe(TODAY);
  });

  it.each([
    ['a past date', isoDaysAgo(75)],
    ['a more recent past date', isoDaysAgo(20)],
    ['today', TODAY],
    ['a future date', daysFromToday(45)],
  ])('reports every balance at %s from the ledger’s own lines', async (_label, asOf) => {
    const want = await expected(asOf);
    const body = await getBalances(h.app, { asOf });

    expect(body.asOf).toBe(asOf);
    expect(want.seedLines).toBeGreaterThan(0);
    for (const row of body.accounts) {
      expect(row.balanceMinor).toBe(want.display.get(row.ledgerAccountId));
    }
    expect(body.subtotals.asset).toBe(want.subtotals.asset);
    expect(body.subtotals.liability).toBe(want.subtotals.liability);
    expect(body.netWorthMinor).toBe(want.netWorth);
  });

  it('accepts a future date — a ledger’s balance at a future date is well defined', async () => {
    const future = daysFromToday(400);
    const res = await request(h.app).get(balances).query({ asOf: future });

    expect(res.status).toBe(200);
    expect(BalancesResponse.parse(res.body).asOf).toBe(future);
  });

  it('moves a balance between two dates by exactly the entries in between', async () => {
    const id = await createAccount('asset', 'Point In Time');
    await postEntry({
      occurredOn: isoDaysAgo(9),
      payee: 'First',
      accountId: id,
      categoryId: ALICE_ACCOUNTS.salary,
      amountMinor: '40000',
    });
    await postEntry({
      occurredOn: isoDaysAgo(4),
      payee: 'Second',
      accountId: id,
      categoryId: ALICE_ACCOUNTS.groceries,
      amountMinor: '-2500',
    });

    const at = async (asOf: string): Promise<bigint> => {
      const body = await getBalances(h.app, { asOf });
      const row = body.accounts.find((r) => r.ledgerAccountId === id);
      expect(row).toBeDefined();
      return row?.balanceMinor ?? 0n;
    };

    expect(await at(isoDaysAgo(10))).toBe(0n);
    expect(await at(isoDaysAgo(9))).toBe(40_000n);
    expect(await at(isoDaysAgo(5))).toBe(40_000n);
    expect(await at(isoDaysAgo(4))).toBe(37_500n);
    expect(await at(TODAY)).toBe(37_500n);
  });
});

describe('the sign convention — ARCHITECTURE §4, the #1 bug source', () => {
  it('shows a liability that owes money as a positive balance', async () => {
    // The seeded card opens owing $452 and is charged all through the history.
    const asOf = isoDaysAgo(1);
    const want = await expected(asOf);
    const stored = want.raw.get(ALICE_ACCOUNTS.visa) ?? 0n;

    expect(stored).toBeLessThan(0n);

    const body = await getBalances(h.app, { asOf });
    const visa = body.accounts.find(
      (row) => row.ledgerAccountId === ALICE_ACCOUNTS.visa,
    );

    expect(visa?.kind).toBe('liability');
    expect(visa?.balanceMinor).toBe(-stored);
    expect(visa?.balanceMinor).toBeGreaterThan(0n);
  });

  it('subtotals a card with $800 owed to 800, not to −800', async () => {
    const card = await createAccount('liability', 'Sign Test Card');
    await postEntry({
      occurredOn: isoDaysAgo(3),
      payee: 'Charged',
      accountId: card,
      categoryId: ALICE_ACCOUNTS.household,
      amountMinor: '-80000',
    });

    const body = await getBalances();
    const row = body.accounts.find((r) => r.ledgerAccountId === card);

    expect(row?.kind).toBe('liability');
    expect(row?.balanceMinor).toBe(80_000n);

    const stored = await h.db.entryLine.aggregate({
      where: { ledgerAccountId: card },
      _sum: { amountMinor: true },
    });
    expect(stored._sum.amountMinor).toBe(-80_000n);
  });

  it('reduces a card’s displayed balance when it is paid down', async () => {
    const card = await createAccount('liability', 'Paid Down Card');
    await postEntry({
      occurredOn: isoDaysAgo(3),
      payee: 'Charged',
      accountId: card,
      categoryId: ALICE_ACCOUNTS.household,
      amountMinor: '-80000',
    });
    await postEntry({
      occurredOn: isoDaysAgo(2),
      payee: 'Card payment',
      lines: [
        { ledgerAccountId: card, amountMinor: '30000' },
        { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-30000' },
      ],
    });

    const body = await getBalances();
    const row = body.accounts.find((r) => r.ledgerAccountId === card);

    expect(row?.balanceMinor).toBe(50_000n);
    expect((await getBalances(h.app, { asOf: isoDaysAgo(3) })).accounts.find(
      (r) => r.ledgerAccountId === card,
    )?.balanceMinor).toBe(80_000n);
  });

  it('leaves an asset balance unflipped', async () => {
    const vault = await createAccount('asset', 'Sign Test Vault');
    await postEntry({
      occurredOn: isoDaysAgo(3),
      payee: 'Funded',
      accountId: vault,
      categoryId: ALICE_ACCOUNTS.salary,
      amountMinor: '25000',
    });

    const body = await getBalances();

    expect(
      body.accounts.find((r) => r.ledgerAccountId === vault)?.balanceMinor,
    ).toBe(25_000n);
    const stored = await h.db.entryLine.aggregate({
      where: { ledgerAccountId: vault },
      _sum: { amountMinor: true },
    });
    expect(stored._sum.amountMinor).toBe(25_000n);
  });

  it('never exposes an income account through the balances endpoints', async () => {
    // `AccountBalance.kind` is `AccountKind` = asset | liability, so an income
    // balance is unrepresentable here. The list must omit it, and the
    // per-account endpoint must refuse it rather than invent a kind.
    const body = await getBalances();
    expect(body.accounts.map((row) => row.ledgerAccountId)).not.toContain(
      ALICE_ACCOUNTS.salary,
    );

    const res = await request(h.app).get(balance(ALICE_ACCOUNTS.salary));

    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expectProblem(res, res.status);
    expect(JSON.stringify(res.body)).not.toContain('income');
  });

  it.each([
    ['an expense category', ALICE_ACCOUNTS.groceries],
    ['the equity opening-balances account', ALICE_ACCOUNTS.openingBalances],
  ])('refuses a balance for %s', async (_label, id) => {
    const res = await request(h.app).get(balance(id));

    expect(res.status).not.toBe(200);
    expectProblem(res, res.status);
  });
});

describe('the three levels, and what a client can reconstruct', () => {
  it('reports net worth as the raw signed sum, not the sum of the display subtotals', async () => {
    const body = await getBalances();

    expect(body.subtotals.liability).not.toBe(0n);
    expect(body.netWorthMinor).toBe(
      body.subtotals.asset - body.subtotals.liability,
    );
    expect(body.netWorthMinor).not.toBe(
      body.subtotals.asset + body.subtotals.liability,
    );
  });

  it('subtotals every row of a kind, archived rows included', async () => {
    const body = await getBalances();
    const sum = (kind: 'asset' | 'liability'): bigint =>
      body.accounts
        .filter((row) => row.kind === kind)
        .reduce((total, row) => total + row.balanceMinor, 0n);

    expect(body.subtotals.asset).toBe(sum('asset'));
    expect(body.subtotals.liability).toBe(sum('liability'));
  });

  it('matches an independently derived net worth over the owner’s own accounts', async () => {
    const want = await expected(TODAY);
    const body = await getBalances();

    expect(want.seedLines).toBeGreaterThan(0);
    expect(body.netWorthMinor).toBe(want.netWorth);
  });
});

describe('exclusion, futures and emptiness', () => {
  it('counts an excluded line in the balance — the money still moved', async () => {
    const plain = await createAccount('asset', 'Exclusion Control');
    const excluded = await createAccount('asset', 'Exclusion Subject');

    await postEntry({
      occurredOn: isoDaysAgo(6),
      payee: 'Lunch, reported',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.dining, amountMinor: '10000' },
        { ledgerAccountId: plain, amountMinor: '-10000' },
      ],
    });
    await postEntry({
      occurredOn: isoDaysAgo(6),
      payee: 'Lunch, reimbursed',
      lines: [
        {
          ledgerAccountId: ALICE_ACCOUNTS.dining,
          amountMinor: '10000',
          excludedFromReporting: true,
        },
        { ledgerAccountId: excluded, amountMinor: '-10000' },
      ],
    });

    const body = await getBalances();
    const at = (id: string): bigint | undefined =>
      body.accounts.find((row) => row.ledgerAccountId === id)?.balanceMinor;

    expect(at(plain)).toBe(-10_000n);
    expect(at(excluded)).toBe(-10_000n);
    expect(at(excluded)).toBe(at(plain));

    const flagged = await h.db.entryLine.count({
      where: { entry: { payee: 'Lunch, reimbursed' }, excludedFromReporting: true },
    });
    expect(flagged).toBe(1);
  });

  it('keeps the seeded reimbursed lunch in the checking balance', async () => {
    // The seed's `team-lunch` excludes $60 of a $100 debit. Exclusion lives on
    // the line and is a reporting dimension — it may not move the bank balance.
    const asOf = TODAY;
    const want = await expected(asOf);
    const body = await getBalances(h.app, { asOf });

    expect(
      body.accounts.find((r) => r.ledgerAccountId === ALICE_ACCOUNTS.checking)
        ?.balanceMinor,
    ).toBe(want.display.get(ALICE_ACCOUNTS.checking));
  });

  it('keeps a future-dated entry out of today’s balance and in a future one', async () => {
    const id = await createAccount('asset', 'Future Fund');
    const before = await getBalances();
    const netBefore = before.netWorthMinor;

    await postFutureEntry(daysFromToday(10), [
      { ledgerAccountId: id, amountMinor: 50_000n },
      { ledgerAccountId: ALICE_ACCOUNTS.salary, amountMinor: -50_000n },
    ]);

    const today = await getBalances();
    const rowToday = today.accounts.find((r) => r.ledgerAccountId === id);
    expect(rowToday?.balanceMinor).toBe(0n);
    expect(today.netWorthMinor).toBe(netBefore);

    const eve = await getBalances(h.app, { asOf: daysFromToday(9) });
    expect(
      eve.accounts.find((r) => r.ledgerAccountId === id)?.balanceMinor,
    ).toBe(0n);

    const after = await getBalances(h.app, { asOf: daysFromToday(10) });
    expect(
      after.accounts.find((r) => r.ledgerAccountId === id)?.balanceMinor,
    ).toBe(50_000n);
    // Derived from the ledger at that date, not from today's net worth plus
    // this entry: the subject is one account's balance at three dates, and any
    // other suite's future-dated entry also sits inside `today … today + 10`.
    expect(after.netWorthMinor).toBe((await expected(daysFromToday(10))).netWorth);
  });

  it('returns "0" for an account with no entries — present, not null or blank', async () => {
    const id = await createAccount('asset', 'Empty Account');

    const body = await rawBody(balances);
    const row = (body['accounts'] as Record<string, unknown>[]).find(
      (candidate) => candidate['ledgerAccountId'] === id,
    );

    expect(row).toBeDefined();
    expect(row?.['balanceMinor']).toBe('0');

    const single = await rawBody(balance(id));
    expect(single['balanceMinor']).toBe('0');
    expect(AccountBalanceResponse.parse(single).balanceMinor).toBe(0n);
  });

  it('carries an amount larger than Number.MAX_SAFE_INTEGER without loss', async () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const asset = await createAccount('asset', 'Big Asset');
    const liability = await createAccount('liability', 'Big Liability');

    await postEntry({
      occurredOn: isoDaysAgo(2),
      payee: 'Very large',
      lines: [
        { ledgerAccountId: asset, amountMinor: huge.toString() },
        { ledgerAccountId: liability, amountMinor: (-huge).toString() },
      ],
    });

    // Localises a failure: if this fails the create path lost the precision.
    const stored = await h.db.entryLine.aggregate({
      where: { ledgerAccountId: asset },
      _sum: { amountMinor: true },
    });
    expect(stored._sum.amountMinor).toBe(huge);

    const body = await getBalances();
    expect(
      body.accounts.find((r) => r.ledgerAccountId === asset)?.balanceMinor,
    ).toBe(huge);
    expect(
      body.accounts.find((r) => r.ledgerAccountId === liability)?.balanceMinor,
    ).toBe(huge);
  });
});

describe('archived accounts keep their money', () => {
  let archivedId: string;

  beforeAll(async () => {
    archivedId = await createAccount('asset', 'Closed Vault');
    await postEntry({
      occurredOn: isoDaysAgo(8),
      payee: 'Funded before closing',
      accountId: archivedId,
      categoryId: ALICE_ACCOUNTS.salary,
      amountMinor: '123456',
    });
    const archived = await request(h.app).delete(
      apiPath(routes.account(archivedId)),
    );
    expect(archived.status).toBe(204);
  });

  it('returns the archived account, flagged, with its balance intact', async () => {
    const body = await getBalances();
    const row = body.accounts.find((r) => r.ledgerAccountId === archivedId);

    expect(row).toBeDefined();
    expect(row?.archived).toBe(true);
    expect(row?.balanceMinor).toBe(123_456n);

    const list = AccountList.parse((await request(h.app).get(accounts)).body);
    expect(list.map((row) => row.id)).not.toContain(archivedId);
  });

  it('counts it in the asset subtotal and in net worth', async () => {
    const body = await getBalances();
    const assets = body.accounts.filter((row) => row.kind === 'asset');
    const archivedRow = assets.find((row) => row.ledgerAccountId === archivedId);

    // Other files archive accounts of their own into the same database, so the
    // subtotal is checked against every asset row, archived ones included —
    // not against this account's amount alone, which made the result depend on
    // which files ran first.
    expect(archivedRow?.archived).toBe(true);
    expect(archivedRow?.balanceMinor).toBe(123_456n);
    expect(body.subtotals.asset).toBe(
      assets.reduce((total, row) => total + row.balanceMinor, 0n),
    );

    const want = await expected(TODAY);
    expect(body.netWorthMinor).toBe(want.netWorth);
    expect(want.archived.get(archivedId)).toBe(true);
  });

  it('serves its single-account balance too', async () => {
    const res = await request(h.app).get(balance(archivedId));

    expect(res.status).toBe(200);
    const body = AccountBalanceResponse.parse(res.body);
    expect(body.archived).toBe(true);
    expect(body.balanceMinor).toBe(123_456n);
    expect(body.kind).toBe('asset');
  });
});

describe('GET /accounts/:id/balance', () => {
  it('agrees with the row the list gives for the same account and date', async () => {
    const asOf = isoDaysAgo(12);
    const want = await expected(asOf);

    for (const id of [ALICE_ACCOUNTS.checking, ALICE_ACCOUNTS.visa]) {
      const res = await request(h.app).get(balance(id)).query({ asOf });
      expect(res.status).toBe(200);
      const body = AccountBalanceResponse.parse(res.body);

      expect(body.asOf).toBe(asOf);
      expect(body.ledgerAccountId).toBe(id);
      expect(body.balanceMinor).toBe(want.display.get(id));
      expect(typeof (res.body as Record<string, unknown>)['balanceMinor']).toBe(
        'string',
      );
    }
  });

  it('resolves an absent asOf to the server’s UTC date', async () => {
    const res = await request(h.app).get(balance(ALICE_ACCOUNTS.checking));

    expect(res.status).toBe(200);
    expect(AccountBalanceResponse.parse(res.body).asOf).toBe(TODAY);
  });

  it('answers 404 for an account id that does not exist', async () => {
    const res = await request(h.app).get(
      balance('00000000-0000-4000-8000-0000000000cd'),
    );

    expectProblem(res, 404);
  });

  it('rejects a non-uuid id with a 400 problem+json naming the field', async () => {
    expectValidationProblem(await request(h.app).get(balance('not-a-uuid')), 'id');
  });
});

describe('asOf validation — every Zod rejection is a 400 problem+json', () => {
  const bad: [string, string][] = [
    ['a timestamp where a calendar date belongs', '2026-05-04T10:00:00Z'],
    ['a malformed date', '04/05/2026'],
    ['a non-date', 'yesterday'],
    ['an impossible date', '2026-02-30'],
    ['an empty string', ''],
    ['a month only', '2026-05'],
  ];

  it.each(bad)('rejects %s on the balances list', async (_label, asOf) => {
    const res = await request(h.app).get(balances).query({ asOf });

    expectValidationProblem(res, 'asOf');
  });

  it.each(bad)('rejects %s on a single account balance', async (_label, asOf) => {
    const res = await request(h.app)
      .get(balance(ALICE_ACCOUNTS.checking))
      .query({ asOf });

    expectValidationProblem(res, 'asOf');
  });
});

describe('tenancy — a SUM() that leaks across owners is silent', () => {
  it('excludes the decoy’s accounts from the list and its money from the totals', async () => {
    const want = await expected(TODAY);
    const body = await getBalances();

    for (const id of Object.values(BLAKE_ACCOUNTS)) {
      expect(body.accounts.map((row) => row.ledgerAccountId)).not.toContain(id);
    }
    expect(body.netWorthMinor).toBe(want.netWorth);

    // The same aggregate, unscoped: if the endpoint ever dropped the owner
    // filter this is the number it would return instead.
    const unscoped = await h.db.entryLine.findMany({
      where: {
        entry: { occurredOn: { lte: asDate(TODAY) } },
        ledgerAccount: { kind: { in: ['asset', 'liability'] } },
      },
      select: { amountMinor: true },
    });
    const everyone = unscoped.reduce((total, row) => total + row.amountMinor, 0n);

    expect(everyone).not.toBe(want.netWorth);
    expect(body.netWorthMinor).not.toBe(everyone);
  });

  it('does not move the demo tenant’s balances when the decoy posts money', async () => {
    const before = await getBalances();

    const posted = await request(await h.as(BLAKE))
      .post(entries)
      .send({
        occurredOn: isoDaysAgo(1),
        payee: 'REEF windfall',
        accountId: BLAKE_ACCOUNTS.checking,
        categoryId: BLAKE_ACCOUNTS.income,
        amountMinor: '987654321',
      });
    expect([200, 201]).toContain(posted.status);

    const after = await getBalances();

    expect(after.netWorthMinor).toBe(before.netWorthMinor);
    expect(after.subtotals).toEqual(before.subtotals);
    expect(after.accounts).toEqual(before.accounts);
  });

  it('serves the decoy its own totals, computed over its own accounts only', async () => {
    const asBlake = await h.as(BLAKE);
    const body = await getBalances(asBlake);

    const owned = await h.db.ledgerAccount.findMany({
      where: { ownerId: BLAKE, kind: { in: ['asset', 'liability'] } },
      select: { id: true, kind: true },
    });
    const lines = await h.db.entryLine.findMany({
      where: {
        entry: { ownerId: BLAKE, occurredOn: { lte: asDate(TODAY) } },
        ledgerAccountId: { in: owned.map((row) => row.id) },
      },
      select: { amountMinor: true },
    });
    const net = lines.reduce((total, row) => total + row.amountMinor, 0n);

    expect(new Set(body.accounts.map((row) => row.ledgerAccountId))).toEqual(
      new Set(owned.map((row) => row.id)),
    );
    expect(body.netWorthMinor).toBe(net);
    expect(body.accounts.map((row) => row.ledgerAccountId)).not.toContain(
      ALICE_ACCOUNTS.checking,
    );
  });

  it('answers 404 — never 403 — for a single balance of the decoy’s account', async () => {
    const res: Response = await request(h.app).get(
      balance(BLAKE_ACCOUNTS.checking),
    );

    expectProblem(res, 404);
    expect(JSON.stringify(res.body)).not.toContain('Reef');
  });
});
