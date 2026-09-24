import type { Client, DatabaseError } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BalancesResponse,
  CorrectionResponse,
  Entry,
  EntryAlreadyCorrectedProblem,
  PROBLEM_CONTENT_TYPE,
  apiPath,
  routes,
} from '@pfm/contracts';
import {
  ALICE,
  ALICE_ACCOUNTS,
  BLAKE,
  connectRaw,
  isoDaysAgo,
  reconcile,
  startHarness,
  type Harness,
} from '../../test/harness.js';
import { expectProblem } from '../../test/problem.js';

const entries = apiPath(routes.entries);
const correction = (id: string): string => apiPath(routes.entryCorrection(id));
const balances = apiPath(routes.accountBalances);

let h: Harness;
let raw: Client;

beforeAll(async () => {
  h = await startHarness();
  raw = await connectRaw();
});

afterAll(async () => {
  await raw.end();
  await h.close();
});

describe('the database refuses a second reversal of the same entry', () => {
  const insertBalancedEntry = async (
    client: Client,
    payee: string,
    reversesEntryId: string | null,
    sign: 1n | -1n = 1n,
  ): Promise<string> => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO entries (owner_id, occurred_on, payee, reverses_entry_id)
       VALUES ($1, $2::date, $3, $4::uuid) RETURNING id`,
      [ALICE, isoDaysAgo(2), payee, reversesEntryId],
    );
    const id = res.rows[0]?.id as string;
    await client.query(
      `INSERT INTO entry_lines (entry_id, ledger_account_id, amount_minor)
       VALUES ($1, $2, $3::bigint), ($1, $4, $5::bigint)`,
      [
        id,
        ALICE_ACCOUNTS.groceries,
        (1500n * sign).toString(),
        ALICE_ACCOUNTS.checking,
        (-1500n * sign).toString(),
      ],
    );
    return id;
  };

  const committed = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    await raw.query('BEGIN');
    try {
      const out = await fn(raw);
      await raw.query('COMMIT');
      return out;
    } catch (error) {
      await raw.query('ROLLBACK');
      throw error;
    }
  };

  it('rejects a second entry whose reverses_entry_id names an already-reversed entry with 23505', async () => {
    const original = await committed((c) =>
      insertBalancedEntry(c, 'Raw original', null),
    );
    const firstReversal = await committed((c) =>
      insertBalancedEntry(c, 'Raw reversal 1', original, -1n),
    );
    expect(firstReversal).toBeTruthy();

    let caught: unknown;
    await raw.query('BEGIN');
    try {
      // Balanced lines are never reached: the entry header itself must fail,
      // so the failure is the uniqueness one and not the deferred zero-sum.
      await raw.query(
        `INSERT INTO entries (owner_id, occurred_on, payee, reverses_entry_id)
         VALUES ($1, $2::date, 'Raw reversal 2', $3::uuid)`,
        [ALICE, isoDaysAgo(1), original],
      );
    } catch (error) {
      caught = error;
    } finally {
      await raw.query('ROLLBACK');
    }

    expect(caught).toBeDefined();
    expect((caught as DatabaseError).code).toBe('23505');

    const count = await raw.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM entries WHERE reverses_entry_id = $1',
      [original],
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  it('rejects the second reversal even when it is fully balanced and committed as a unit', async () => {
    const original = await committed((c) =>
      insertBalancedEntry(c, 'Raw original B', null),
    );
    await committed((c) => insertBalancedEntry(c, 'Raw reversal B1', original, -1n));

    await expect(
      committed((c) => insertBalancedEntry(c, 'Raw reversal B2', original, -1n)),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('leaves entries with a NULL reverses_entry_id unrestricted', async () => {
    const ids = await committed(async (c) => {
      const out: string[] = [];
      for (let i = 0; i < 5; i++) {
        out.push(await insertBalancedEntry(c, `Plain entry ${i}`, null));
      }
      return out;
    });
    expect(new Set(ids).size).toBe(5);

    const count = await raw.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entries
       WHERE reverses_entry_id IS NULL AND id = ANY($1::uuid[])`,
      [ids],
    );
    expect(count.rows[0]?.n).toBe('5');
  });
});

describe('POST /entries/:id/correction corrects an entry at most once', () => {
  const replacementBody = {
    replacement: {
      payee: 'Corrected once',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-3100',
    },
  };

  const filedEntry = async (): Promise<string> => {
    const res = await request(h.app).post(entries).send({
      occurredOn: isoDaysAgo(40),
      payee: 'Single reversal subject',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.groceries,
      amountMinor: '-3100',
    });
    expect(res.status).toBe(201);
    const created = Entry.parse(res.body);
    await reconcile(h.db, created.id);
    return created.id;
  };

  const ledgerSnapshot = async (): Promise<{
    entries: number;
    lines: number;
    balances: unknown;
  }> => {
    const res = await request(h.app).get(balances);
    expect(res.status).toBe(200);
    const parsed = BalancesResponse.parse(res.body);
    return {
      entries: await h.db.entry.count(),
      lines: await h.db.entryLine.count(),
      balances: {
        netWorthMinor: parsed.netWorthMinor,
        subtotals: parsed.subtotals,
        accounts: [...parsed.accounts].sort((a, b) =>
          a.ledgerAccountId.localeCompare(b.ledgerAccountId),
        ),
      },
    };
  };

  it('accepts the first correction and answers the second with a 409 naming the reversal, writing nothing', async () => {
    const id = await filedEntry();

    const first = await request(h.app).post(correction(id)).send(replacementBody);
    expect(first.status).toBe(201);
    const { reversal } = CorrectionResponse.parse(first.body);

    const before = await ledgerSnapshot();

    const second = await request(h.app).post(correction(id)).send(replacementBody);

    expect(second.status).toBe(409);
    expect(second.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expectProblem(second, 409);
    const problem = EntryAlreadyCorrectedProblem.parse(second.body);
    expect(problem.reversedByEntryId).toBe(reversal.id);
    expect(problem.reversal).toContain(reversal.id);

    expect(await ledgerSnapshot()).toEqual(before);
    expect(await h.db.entry.count({ where: { reversesEntryId: id } })).toBe(1);
    expect(await h.db.entry.count({ where: { replacesEntryId: id } })).toBe(1);
  });

  it("answers another owner's correction attempt with 404, not the 409", async () => {
    const id = await filedEntry();
    const blake = await h.as(BLAKE);

    expectProblem(
      await request(blake).post(correction(id)).send(replacementBody),
      404,
    );

    const first = await request(h.app).post(correction(id)).send(replacementBody);
    expect(first.status).toBe(201);
    const before = await ledgerSnapshot();

    const foreign = await request(blake).post(correction(id)).send(replacementBody);
    const problem = expectProblem(foreign, 404);
    expect(foreign.status).not.toBe(409);
    expect(problem).not.toHaveProperty('reversedByEntryId');
    expect(foreign.text).not.toContain(CorrectionResponse.parse(first.body).reversal.id);

    expect(await ledgerSnapshot()).toEqual(before);
  });

  it('lets exactly one of two concurrent corrections through', async () => {
    const id = await filedEntry();
    const entriesBefore = await h.db.entry.count();

    const results = await Promise.all([
      request(h.app).post(correction(id)).send(replacementBody),
      request(h.app).post(correction(id)).send(replacementBody),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    const winner = results.find((r) => r.status === 201);
    expect(loser?.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const problem = EntryAlreadyCorrectedProblem.parse(loser?.body);
    expect(problem.reversedByEntryId).toBe(
      CorrectionResponse.parse(winner?.body).reversal.id,
    );

    expect(await h.db.entry.count({ where: { reversesEntryId: id } })).toBe(1);
    expect(await h.db.entry.count({ where: { replacesEntryId: id } })).toBe(1);
    expect(await h.db.entry.count()).toBe(entriesBefore + 2);
  });
});
