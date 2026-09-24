import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATEGORY_KINDS, CategoryList, apiPath, routes } from '@pfm/contracts';
import { ALICE_ACCOUNTS, startHarness, type Harness } from '../../test/harness.js';
import { expectValidationProblem } from '../../test/problem.js';

const categories = apiPath(routes.categories);

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

describe('GET /categories — the income | expense window onto ledger_accounts', () => {
  it('returns rows that satisfy the Category contract and nothing else', async () => {
    const res = await request(h.app).get(categories);

    expect(res.status).toBe(200);
    const list = CategoryList.parse(res.body);
    expect(list.length).toBeGreaterThan(0);
    for (const row of list) {
      expect(CATEGORY_KINDS).toContain(row.kind);
    }
  });

  it('never returns an asset, liability or equity row', async () => {
    const res = await request(h.app).get(categories);
    const ids = (res.body as { id: string }[]).map((row) => row.id);
    const names = (res.body as { name: string }[]).map((row) => row.name);

    expect(ids).toContain(ALICE_ACCOUNTS.groceries);
    expect(ids).toContain(ALICE_ACCOUNTS.salary);
    expect(ids).not.toContain(ALICE_ACCOUNTS.checking);
    expect(ids).not.toContain(ALICE_ACCOUNTS.visa);
    expect(ids).not.toContain(ALICE_ACCOUNTS.openingBalances);
    expect(names).not.toContain('Everyday Checking');
    expect(names).not.toContain('Visa Credit Card');
    expect(names).not.toContain('Opening Balances');
  });

  it('is exactly one level — no row carries a parent', async () => {
    const res = await request(h.app).get(categories);

    for (const row of res.body as Record<string, unknown>[]) {
      expect(Object.keys(row)).not.toContain('parentId');
      expect(Object.keys(row)).not.toContain('parent_id');
      expect(Object.keys(row)).not.toContain('children');
    }
  });

  it.each(CATEGORY_KINDS)('filters to kind=%s when asked', async (kind) => {
    const res = await request(h.app).get(categories).query({ kind });

    expect(res.status).toBe(200);
    const list = CategoryList.parse(res.body);
    expect(list.length).toBeGreaterThan(0);
    for (const row of list) {
      expect(row.kind).toBe(kind);
    }
  });

  it.each(['asset', 'liability', 'equity', 'nonsense'])(
    'rejects kind=%s with a 400 problem+json',
    async (kind) => {
      const res = await request(h.app).get(categories).query({ kind });

      expectValidationProblem(res, 'kind');
    },
  );
});
