import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNT_KINDS,
  AccountList,
  LedgerAccount,
  TransactionPage,
  apiPath,
  routes,
} from '@pfm/contracts';
import {
  ALICE_ACCOUNTS,
  isoDaysAgo,
  startHarness,
  uniqueName,
  type Harness,
} from '../../test/harness.js';
import { expectProblem, expectValidationProblem } from '../../test/problem.js';

const accounts = apiPath(routes.accounts);
const account = (id: string): string => apiPath(routes.account(id));
const entries = apiPath(routes.entries);

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

const createAccount = async (
  body: Record<string, unknown>,
): Promise<LedgerAccount> => {
  const res = await request(h.app).post(accounts).send(body);
  expect([200, 201]).toContain(res.status);
  return LedgerAccount.parse(res.body);
};

describe('GET /accounts — the asset | liability window onto ledger_accounts', () => {
  it('returns rows that satisfy the LedgerAccount contract and nothing else', async () => {
    const res = await request(h.app).get(accounts);

    expect(res.status).toBe(200);
    const list = AccountList.parse(res.body);
    expect(list.length).toBeGreaterThan(0);
    for (const row of list) {
      expect(ACCOUNT_KINDS).toContain(row.kind);
    }
  });

  it('never returns an income, expense or equity row', async () => {
    const res = await request(h.app).get(accounts);
    const ids = (res.body as { id: string }[]).map((row) => row.id);
    const names = (res.body as { name: string }[]).map((row) => row.name);

    expect(ids).toContain(ALICE_ACCOUNTS.checking);
    expect(ids).toContain(ALICE_ACCOUNTS.visa);
    // Seeded income, expense and equity rows live in the same table.
    expect(ids).not.toContain(ALICE_ACCOUNTS.salary);
    expect(ids).not.toContain(ALICE_ACCOUNTS.groceries);
    expect(ids).not.toContain(ALICE_ACCOUNTS.openingBalances);
    expect(names).not.toContain('Salary');
    expect(names).not.toContain('Groceries');
    expect(names).not.toContain('Opening Balances');
  });
});

describe('POST /accounts', () => {
  it('creates a liability account and defaults the currency to USD', async () => {
    const created = await createAccount({
      name: uniqueName('Test Card'),
      kind: 'liability',
    });

    expect(created.kind).toBe('liability');
    expect(created.currency).toBe('USD');
    expect(created.isSystem).toBe(false);
    expect(created.archivedAt).toBeNull();

    const list = AccountList.parse((await request(h.app).get(accounts)).body);
    expect(list.map((row) => row.id)).toContain(created.id);
  });

  it('compares names case-sensitively: "Kitchen" and "kitchen" coexist, an exact repeat is a 409', async () => {
    const suffix = uniqueName('').trim();
    const upper = await createAccount({ name: `Kitchen ${suffix}`, kind: 'asset' });
    const lower = await createAccount({ name: `kitchen ${suffix}`, kind: 'asset' });
    expect(lower.id).not.toBe(upper.id);

    expectProblem(
      await request(h.app).post(accounts).send({ name: `kitchen ${suffix}`, kind: 'asset' }),
      409,
    );

    const list = AccountList.parse((await request(h.app).get(accounts)).body);
    expect(list.filter((row) => row.name.toLowerCase() === `kitchen ${suffix}`.toLowerCase())).toHaveLength(2);
  });

  it.each([
    ['an empty body', {}, undefined],
    ['a missing name', { kind: 'asset' }, 'name'],
    ['a blank name', { name: '   ', kind: 'asset' }, 'name'],
    ['an over-long name', { name: 'x'.repeat(81), kind: 'asset' }, 'name'],
    ['a missing kind', { name: 'No Kind' }, 'kind'],
    // Categories are not accounts, however identical the table underneath is.
    ['kind=expense', { name: 'Not An Account', kind: 'expense' }, 'kind'],
    ['kind=income', { name: 'Not An Account', kind: 'income' }, 'kind'],
    ['kind=equity', { name: 'Not An Account', kind: 'equity' }, 'kind'],
    ['a lowercase currency', { name: 'Bad FX', kind: 'asset', currency: 'usd' }, 'currency'],
    ['a non-ISO currency', { name: 'Bad FX', kind: 'asset', currency: 'DOLLARS' }, 'currency'],
    ['a numeric name', { name: 42, kind: 'asset' }, 'name'],
  ])('rejects %s with a 400 problem+json', async (_label, body, path) => {
    const res = await request(h.app).post(accounts).send(body);

    expectValidationProblem(res, path);
  });
});

describe('PATCH /accounts/:id', () => {
  it('renames without touching kind or currency', async () => {
    const created = await createAccount({
      name: uniqueName('Before'),
      kind: 'asset',
    });
    const renamed = uniqueName('After');

    const res = await request(h.app)
      .patch(account(created.id))
      .send({ name: renamed });

    expect(res.status).toBe(200);
    const parsed = LedgerAccount.parse(res.body);
    expect(parsed.name).toBe(renamed);
    expect(parsed.kind).toBe(created.kind);
    expect(parsed.currency).toBe(created.currency);
  });

  it('rejects a blank name with a 400 problem+json', async () => {
    const created = await createAccount({
      name: uniqueName('Rename Guard'),
      kind: 'asset',
    });

    const res = await request(h.app)
      .patch(account(created.id))
      .send({ name: '' });

    expectValidationProblem(res, 'name');
  });

  it('rejects a non-uuid id with a 400 problem+json', async () => {
    const res = await request(h.app)
      .patch(account('not-a-uuid'))
      .send({ name: 'Anything' });

    expectValidationProblem(res, 'id');
  });

  it('answers 404 for an id that does not exist', async () => {
    const res = await request(h.app)
      .patch(account('00000000-0000-4000-8000-0000000000ff'))
      .send({ name: 'Ghost' });

    expectProblem(res, 404);
  });
});

describe('DELETE /accounts/:id — archived, never deleted', () => {
  it('returns 204, hides the account from the list, and keeps its history', async () => {
    const archived = await createAccount({
      name: uniqueName('To Archive'),
      kind: 'asset',
    });

    const posted = await request(h.app)
      .post(entries)
      .send({
        occurredOn: isoDaysAgo(1),
        payee: 'Historical Purchase',
        accountId: archived.id,
        categoryId: ALICE_ACCOUNTS.groceries,
        amountMinor: '-1234',
      });
    expect([200, 201]).toContain(posted.status);

    const res = await request(h.app).delete(account(archived.id));
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    const list = AccountList.parse((await request(h.app).get(accounts)).body);
    expect(list.map((row) => row.id)).not.toContain(archived.id);

    const row = await h.db.ledgerAccount.findUnique({
      where: { id: archived.id },
    });
    expect(row).not.toBeNull();
    expect(row?.archivedAt).not.toBeNull();

    const register = await request(h.app)
      .get(entries)
      .query({ accountId: archived.id });
    expect(register.status).toBe(200);
    const page = TransactionPage.parse(register.body);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.payee).toBe('Historical Purchase');
  });

  it('answers 404 for an id that does not exist', async () => {
    const res = await request(h.app).delete(
      account('00000000-0000-4000-8000-0000000000fe'),
    );

    expectProblem(res, 404);
  });
});
