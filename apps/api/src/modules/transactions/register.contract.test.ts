import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Entry,
  LedgerAccount,
  MAX_PAGE_SIZE,
  TransactionPage,
  TransactionRowView,
  apiPath,
  routes,
} from '@pfm/contracts';
import {
  ALICE_ACCOUNTS,
  isoDaysAgo,
  startHarness,
  todayIso,
  uniqueName,
  type Harness,
} from '../../test/harness.js';
import { expectValidationProblem } from '../../test/problem.js';

const entries = apiPath(routes.entries);
const accounts = apiPath(routes.accounts);

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

const post = async (body: Record<string, unknown>): Promise<Entry> => {
  const res = await request(h.app).post(entries).send(body);
  expect([200, 201]).toContain(res.status);
  return Entry.parse(res.body);
};

const register = async (
  query: Record<string, string | number>,
): Promise<TransactionPage> => {
  const res = await request(h.app).get(entries).query(query);
  expect(res.status).toBe(200);
  return TransactionPage.parse(res.body);
};

const rowFor = (page: TransactionPage, entryId: string): TransactionRowView => {
  const found = page.data.filter((row) => row.entryId === entryId);
  expect(found).toHaveLength(1);
  return found[0] as TransactionRowView;
};

const freshAsset = async (label: string): Promise<string> => {
  const res = await request(h.app)
    .post(accounts)
    .send({ name: uniqueName(label), kind: 'asset' });
  expect([200, 201]).toContain(res.status);
  return LedgerAccount.parse(res.body).id;
};

describe('GET /entries — the sign convention at the DTO boundary', () => {
  it('leaves an asset row in its stored sign', async () => {
    const account = await freshAsset('Sign Asset');
    const created = await post({
      occurredOn: todayIso(),
      payee: 'Harvest Foods',
      accountId: account,
      categoryId: ALICE_ACCOUNTS.groceries,
      amountMinor: '-4200',
    });

    const row = rowFor(await register({ accountId: account }), created.id);

    expect(row.amountMinor).toBe(-4200n);
    expect(row.counterparty.kind).toBe('single');
    if (row.counterparty.kind === 'single') {
      expect(row.counterparty.ledgerAccountKind).toBe('expense');
      expect(row.counterparty.name).toBe('Groceries');
    }
  });

  it('flips a liability row once: $50 charged to the card reads as +5000', async () => {
    const created = await post({
      occurredOn: todayIso(),
      payee: 'Sign Liability Charge',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '5000' },
        { ledgerAccountId: ALICE_ACCOUNTS.visa, amountMinor: '-5000' },
      ],
    });

    const row = rowFor(
      await register({ accountId: ALICE_ACCOUNTS.visa, limit: MAX_PAGE_SIZE }),
      created.id,
    );

    // Stored −5000 on a liability; displaySign(liability) = −1.
    expect(row.amountMinor).toBe(5000n);
  });

  it('flips a liability row the other way: paying $800 off the card reads as −80000', async () => {
    const created = await post({
      occurredOn: todayIso(),
      payee: 'Sign Liability Payment',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.visa, amountMinor: '80000' },
        { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-80000' },
      ],
    });

    const row = rowFor(
      await register({ accountId: ALICE_ACCOUNTS.visa, limit: MAX_PAGE_SIZE }),
      created.id,
    );

    expect(row.amountMinor).toBe(-80000n);
    expect(row.counterparty.kind).toBe('single');
    if (row.counterparty.kind === 'single') {
      // Paying the card touches no expense account.
      expect(row.counterparty.ledgerAccountKind).toBe('asset');
    }
  });

  it('flips an income row: a $3,000 salary reads as +300000', async () => {
    const created = await post({
      occurredOn: todayIso(),
      payee: 'Sign Income',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '300000' },
        { ledgerAccountId: ALICE_ACCOUNTS.salary, amountMinor: '-300000' },
      ],
    });

    const row = rowFor(
      await register({ accountId: ALICE_ACCOUNTS.salary, limit: MAX_PAGE_SIZE }),
      created.id,
    );

    // Stored −300000 on an income account; displaySign(income) = −1.
    expect(row.amountMinor).toBe(300000n);
  });
});

describe('money on the wire', () => {
  it('sends every amount as a string of minor units, never a JSON number', async () => {
    const created = await post({
      occurredOn: todayIso(),
      payee: 'Wire format',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '900719925474099' },
        { ledgerAccountId: ALICE_ACCOUNTS.visa, amountMinor: '-900719925474099' },
      ],
    });

    const detail = await request(h.app).get(apiPath(routes.entry(created.id)));
    for (const line of (detail.body as { lines: { amountMinor: unknown }[] }).lines) {
      expect(typeof line.amountMinor).toBe('string');
      expect(line.amountMinor as string).toMatch(/^-?\d+$/);
    }

    const list = await request(h.app)
      .get(entries)
      .query({ accountId: ALICE_ACCOUNTS.visa, limit: MAX_PAGE_SIZE });
    const raw = (list.body as { data: { entryId: string; amountMinor: unknown }[] }).data;
    const row = raw.find((candidate) => candidate.entryId === created.id);
    expect(typeof row?.amountMinor).toBe('string');

    // An amount beyond Number.MAX_SAFE_INTEGER survives the round trip intact,
    // which is the whole reason it is not a JSON number.
    expect(BigInt(row?.amountMinor as string)).toBe(900719925474099n);
  });
});

describe('GET /entries — the register row is a projection of one account', () => {
  it('collapses a counter-side of more than one line to a split', async () => {
    const account = await freshAsset('Split Source');
    const created = await post({
      occurredOn: todayIso(),
      payee: 'Maple Street Hardware',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '3000' },
        { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '20000' },
        { ledgerAccountId: account, amountMinor: '-23000' },
      ],
    });

    const page = await register({ accountId: account });
    const row = rowFor(page, created.id);

    // One row, not one per counter line.
    expect(page.data).toHaveLength(1);
    expect(row.counterparty).toEqual({ kind: 'split' });
    expect(row.amountMinor).toBe(-23000n);
  });

  it('shows the counter line inline, with its dimensions, when there is exactly one', async () => {
    const account = await freshAsset('Single Counter');
    const project = await h.db.project.create({
      data: { ownerId: (await h.db.ledgerAccount.findUniqueOrThrow({ where: { id: account } })).ownerId, name: uniqueName('Register project') },
    });

    const created = await post({
      occurredOn: todayIso(),
      payee: 'Timberline Supply',
      lines: [
        {
          ledgerAccountId: ALICE_ACCOUNTS.household,
          amountMinor: '7500',
          projectId: project.id,
          excludedFromReporting: true,
        },
        { ledgerAccountId: account, amountMinor: '-7500' },
      ],
    });

    const row = rowFor(await register({ accountId: account }), created.id);

    expect(row.counterparty).toEqual({
      kind: 'single',
      ledgerAccountId: ALICE_ACCOUNTS.household,
      name: 'Household',
      ledgerAccountKind: 'expense',
      projectId: project.id,
      excludedFromReporting: true,
    });
  });

  it('returns only entries that touch the requested account', async () => {
    const account = await freshAsset('Scoped Register');
    const mine = await post({
      occurredOn: todayIso(),
      payee: 'Mine',
      accountId: account,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-1000',
    });
    await post({
      occurredOn: todayIso(),
      payee: 'Not mine',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-1000',
    });

    const page = await register({ accountId: account });

    expect(page.data.map((row) => row.entryId)).toEqual([mine.id]);
  });
});

describe('GET /entries — keyset pagination on (occurred_on DESC, id DESC)', () => {
  const drain = async (
    accountId: string,
    limit: number,
    onPage?: (page: TransactionPage) => Promise<void>,
  ): Promise<TransactionRowView[]> => {
    const seen: TransactionRowView[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 50; guard += 1) {
      const page: TransactionPage = await register({
        accountId,
        limit,
        ...(cursor === null ? {} : { cursor }),
      });
      seen.push(...page.data);
      if (onPage) await onPage(page);
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    return seen;
  };

  const isDescending = (rows: readonly TransactionRowView[]): boolean =>
    rows.every((row, index) => {
      if (index === 0) return true;
      const previous = rows[index - 1] as TransactionRowView;
      if (previous.occurredOn !== row.occurredOn) {
        return previous.occurredOn > row.occurredOn;
      }
      return previous.lineId > row.lineId || previous.entryId > row.entryId;
    });

  it('walks a tie on occurred_on without a duplicate or a gap', async () => {
    const account = await freshAsset('Keyset Tie');
    const tied = isoDaysAgo(7);
    const ids: string[] = [];

    for (let n = 0; n < 5; n += 1) {
      const created = await post({
        occurredOn: tied,
        payee: `Tie ${n}`,
        accountId: account,
        categoryId: ALICE_ACCOUNTS.dining,
        amountMinor: `-${100 + n}`,
      });
      ids.push(created.id);
    }
    for (let n = 0; n < 2; n += 1) {
      const created = await post({
        occurredOn: isoDaysAgo(8),
        payee: `Older ${n}`,
        accountId: account,
        categoryId: ALICE_ACCOUNTS.dining,
        amountMinor: `-${200 + n}`,
      });
      ids.push(created.id);
    }

    const rows = await drain(account, 2);

    expect(rows).toHaveLength(ids.length);
    expect(new Set(rows.map((row) => row.entryId)).size).toBe(ids.length);
    expect([...rows.map((row) => row.entryId)].sort()).toEqual([...ids].sort());
    expect(isDescending(rows)).toBe(true);
  });

  it('is stable when a newer row is inserted mid-scan', async () => {
    const account = await freshAsset('Keyset Insert');
    const original: string[] = [];

    for (let n = 0; n < 6; n += 1) {
      const created = await post({
        occurredOn: isoDaysAgo(10),
        payee: `Scan ${n}`,
        accountId: account,
        categoryId: ALICE_ACCOUNTS.dining,
        amountMinor: `-${300 + n}`,
      });
      original.push(created.id);
    }

    let inserted: string | null = null;
    const rows = await drain(account, 2, async () => {
      if (inserted !== null) return;
      const created = await post({
        occurredOn: todayIso(),
        payee: 'Inserted mid-scan',
        accountId: account,
        categoryId: ALICE_ACCOUNTS.dining,
        amountMinor: '-999',
      });
      inserted = created.id;
    });

    const seen = rows.map((row) => row.entryId);
    expect(new Set(seen).size).toBe(seen.length);
    // Every pre-existing row is still reached exactly once; the newer row sorts
    // before the cursor and so is not swept up by a scan already past it.
    for (const id of original) {
      expect(seen).toContain(id);
    }
    expect(seen).not.toContain(inserted);
  });

  it('ends with a null cursor and never returns more than the limit', async () => {
    const account = await freshAsset('Keyset Limit');
    for (let n = 0; n < 3; n += 1) {
      await post({
        occurredOn: isoDaysAgo(11),
        payee: `Limit ${n}`,
        accountId: account,
        categoryId: ALICE_ACCOUNTS.dining,
        amountMinor: `-${400 + n}`,
      });
    }

    const first = await register({ accountId: account, limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await register({
      accountId: account,
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});

describe('GET /entries — query validation', () => {
  it.each([
    ['a missing accountId', {}, 'accountId'],
    ['a non-uuid accountId', { accountId: 'checking' }, 'accountId'],
    ['limit 0', { accountId: ALICE_ACCOUNTS.checking, limit: 0 }, 'limit'],
    ['limit above the maximum', { accountId: ALICE_ACCOUNTS.checking, limit: MAX_PAGE_SIZE + 1 }, 'limit'],
    ['a fractional limit', { accountId: ALICE_ACCOUNTS.checking, limit: 1.5 }, 'limit'],
    ['a non-numeric limit', { accountId: ALICE_ACCOUNTS.checking, limit: 'all' }, 'limit'],
    ['a hand-edited cursor', { accountId: ALICE_ACCOUNTS.checking, cursor: 'nonsense' }, 'cursor'],
    ['a cursor with a bad uuid', { accountId: ALICE_ACCOUNTS.checking, cursor: '2026-01-01:not-a-uuid' }, 'cursor'],
    ['a cursor with a timestamp', { accountId: ALICE_ACCOUNTS.checking, cursor: '2026-01-01T00:00:00Z:00000000-0000-4000-8000-00000000000a' }, 'cursor'],
    ['a timestamp in from', { accountId: ALICE_ACCOUNTS.checking, from: '2026-01-01T00:00:00Z' }, 'from'],
    ['a malformed to', { accountId: ALICE_ACCOUNTS.checking, to: '31/12/2026' }, 'to'],
    ['an empty search term', { accountId: ALICE_ACCOUNTS.checking, q: '  ' }, 'q'],
  ])('rejects %s with a 400 problem+json', async (_label, query, path) => {
    const res = await request(h.app).get(entries).query(query);

    expectValidationProblem(res, path);
  });

  it('narrows to the search term', async () => {
    const account = await freshAsset('Search Filter');
    const wanted = await post({
      occurredOn: isoDaysAgo(12),
      payee: 'Fieldstone Outfitters',
      accountId: account,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-500',
    });
    await post({
      occurredOn: isoDaysAgo(12),
      payee: 'Paper Lantern',
      accountId: account,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-500',
    });

    const page = await register({ accountId: account, q: 'Fieldstone' });

    expect(page.data.map((row) => row.entryId)).toEqual([wanted.id]);
  });

  it('filters by date range', async () => {
    const account = await freshAsset('Range Filter');
    const inside = await post({
      occurredOn: isoDaysAgo(20),
      payee: 'Inside',
      accountId: account,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-500',
    });
    await post({
      occurredOn: isoDaysAgo(40),
      payee: 'Outside',
      accountId: account,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-500',
    });

    const page = await register({
      accountId: account,
      from: isoDaysAgo(25),
      to: isoDaysAgo(15),
    });

    expect(page.data.map((row) => row.entryId)).toEqual([inside.id]);
  });
});
