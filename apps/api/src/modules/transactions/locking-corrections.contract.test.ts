import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CorrectionResponse,
  Entry,
  LockedEntryProblem,
  PROBLEM_CONTENT_TYPE,
  apiPath,
  routes,
} from '@pfm/contracts';
import {
  ALICE,
  ALICE_ACCOUNTS,
  BLAKE_ACCOUNTS,
  isoDaysAgo,
  reconcile,
  startHarness,
  todayIso,
  uniqueName,
  type Harness,
} from '../../test/harness.js';
import { expectProblem, expectValidationProblem } from '../../test/problem.js';

const entries = apiPath(routes.entries);
const entry = (id: string): string => apiPath(routes.entry(id));
const correction = (id: string): string => apiPath(routes.entryCorrection(id));

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

/** An entry in a filed period: posted, reconciled, and therefore locked. */
const filedEntry = async (
  lines?: Record<string, unknown>[],
): Promise<{ id: string; lockedAt: Date }> => {
  const created = await post({
    occurredOn: isoDaysAgo(45),
    payee: 'Riverside Café',
    ...(lines
      ? { lines }
      : {
          accountId: ALICE_ACCOUNTS.checking,
          categoryId: ALICE_ACCOUNTS.groceries,
          amountMinor: '-2400',
        }),
  });
  const lockedAt = await reconcile(h.db, created.id);
  return { id: created.id, lockedAt };
};

const storedLines = async (
  entryId: string,
): Promise<{ ledgerAccountId: string; amountMinor: bigint; projectId: string | null }[]> =>
  (
    await h.db.entryLine.findMany({
      where: { entryId },
      select: { ledgerAccountId: true, amountMinor: true, projectId: true },
      orderBy: { ledgerAccountId: 'asc' },
    })
  ).map((line) => ({ ...line }));

describe('a locked entry refuses every write and says where to go instead', () => {
  it('answers PATCH with a 409 naming lockedAt and the correction endpoint', async () => {
    const filed = await filedEntry();

    const res = await request(h.app)
      .patch(entry(filed.id))
      .send({ payee: 'Cannot touch this' });

    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const problem = LockedEntryProblem.parse(res.body);
    expect(Date.parse(problem.lockedAt)).toBe(filed.lockedAt.getTime());
    expect(problem.correction).toContain(filed.id);
    expect(problem.correction).toContain('correction');

    const unchanged = await h.db.entry.findUniqueOrThrow({
      where: { id: filed.id },
    });
    expect(unchanged.payee).toBe('Riverside Café');
  });

  it('answers PATCH of the lines with the same 409', async () => {
    const filed = await filedEntry();

    const res = await request(h.app)
      .patch(entry(filed.id))
      .send({
        lines: [
          { ledgerAccountId: ALICE_ACCOUNTS.dining, amountMinor: '2400' },
          { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-2400' },
        ],
      });

    expect(res.status).toBe(409);
    LockedEntryProblem.parse(res.body);
    expect(await h.db.entryLine.count({ where: { entryId: filed.id } })).toBe(2);
  });

  it('answers DELETE with a 409 and keeps the entry', async () => {
    const filed = await filedEntry();

    const res = await request(h.app).delete(entry(filed.id));

    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const problem = LockedEntryProblem.parse(res.body);
    expect(Date.parse(problem.lockedAt)).toBe(filed.lockedAt.getTime());

    expect(await h.db.entry.findUnique({ where: { id: filed.id } })).not.toBeNull();
  });
});

describe('POST /entries/:id/correction', () => {
  it('posts a reversal dated today plus a replacement, and never writes the original', async () => {
    const filed = await filedEntry();
    const before = await h.db.entry.findUniqueOrThrow({ where: { id: filed.id } });
    const beforeLines = await storedLines(filed.id);

    const res = await request(h.app)
      .post(correction(filed.id))
      .send({
        replacement: {
          payee: 'Riverside Café',
          memo: 'Dining, not groceries',
          accountId: ALICE_ACCOUNTS.checking,
          categoryId: ALICE_ACCOUNTS.dining,
          amountMinor: '-2400',
        },
      });

    expect([200, 201]).toContain(res.status);
    const { original, reversal, replacement } = CorrectionResponse.parse(res.body);

    expect(original.id).toBe(filed.id);
    expect(reversal.occurredOn).toBe(todayIso());
    expect(replacement.occurredOn).toBe(todayIso());
    expect(reversal.occurredOn).not.toBe(before.occurredOn.toISOString().slice(0, 10));
    expect(reversal.reversesEntryId).toBe(filed.id);
    expect(replacement.replacesEntryId).toBe(filed.id);
    expect(reversal.lockedAt).toBeNull();

    // "Reversed" is a join, not a flag: the original is read back as reversed
    // without a single write to its row.
    expect(original.reversedByEntryId).toBe(reversal.id);

    const after = await h.db.entry.findUniqueOrThrow({ where: { id: filed.id } });
    expect(after).toEqual(before);
    expect(await storedLines(filed.id)).toEqual(beforeLines);
  });

  it('negates every line of the original', async () => {
    const filed = await filedEntry([
      { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '7500' },
      { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '2500' },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-10000' },
    ]);

    const res = await request(h.app)
      .post(correction(filed.id))
      .send({
        replacement: {
          payee: 'Corrected',
          accountId: ALICE_ACCOUNTS.checking,
          categoryId: ALICE_ACCOUNTS.household,
          amountMinor: '-10000',
        },
      });
    expect([200, 201]).toContain(res.status);
    const { reversal } = CorrectionResponse.parse(res.body);

    const originalLines = await storedLines(filed.id);
    const reversalLines = await storedLines(reversal.id);

    expect(reversalLines).toHaveLength(originalLines.length);
    expect(reversalLines).toEqual(
      originalLines.map((line) => ({ ...line, amountMinor: -line.amountMinor })),
    );
    expect(
      reversalLines.reduce((sum, line) => sum + line.amountMinor, 0n),
    ).toBe(0n);
  });

  it('copies project_id onto every line of the reversal', async () => {
    const project = await h.db.project.create({
      data: { ownerId: ALICE, name: uniqueName('Kitchen remodel') },
    });
    const other = await h.db.project.create({
      data: { ownerId: ALICE, name: uniqueName('Trip to France') },
    });

    const filed = await filedEntry([
      {
        ledgerAccountId: ALICE_ACCOUNTS.household,
        amountMinor: '20000',
        projectId: project.id,
      },
      {
        ledgerAccountId: ALICE_ACCOUNTS.groceries,
        amountMinor: '3000',
        projectId: other.id,
      },
      { ledgerAccountId: ALICE_ACCOUNTS.dining, amountMinor: '1000' },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-24000' },
    ]);

    const res = await request(h.app)
      .post(correction(filed.id))
      .send({
        replacement: {
          payee: 'Corrected project spend',
          accountId: ALICE_ACCOUNTS.checking,
          categoryId: ALICE_ACCOUNTS.household,
          amountMinor: '-24000',
        },
      });
    expect([200, 201]).toContain(res.status);
    const { reversal } = CorrectionResponse.parse(res.body);

    const reversalLines = await storedLines(reversal.id);
    const byAccount = new Map(
      reversalLines.map((line) => [line.ledgerAccountId, line]),
    );

    // Omitting this leaves the project total overstated by the original amount.
    expect(byAccount.get(ALICE_ACCOUNTS.household)?.projectId).toBe(project.id);
    expect(byAccount.get(ALICE_ACCOUNTS.household)?.amountMinor).toBe(-20000n);
    expect(byAccount.get(ALICE_ACCOUNTS.groceries)?.projectId).toBe(other.id);
    expect(byAccount.get(ALICE_ACCOUNTS.groceries)?.amountMinor).toBe(-3000n);
    expect(byAccount.get(ALICE_ACCOUNTS.dining)?.projectId).toBeNull();
    expect(byAccount.get(ALICE_ACCOUNTS.checking)?.projectId).toBeNull();
  });

  it('leaves the reconciled bank balance untouched when only the category changed', async () => {
    const filed = await filedEntry();
    const bankTotal = async (): Promise<bigint> =>
      (
        await h.db.entryLine.aggregate({
          where: {
            ledgerAccountId: ALICE_ACCOUNTS.checking,
            entry: { ownerId: ALICE },
          },
          _sum: { amountMinor: true },
        })
      )._sum.amountMinor ?? 0n;

    const before = await bankTotal();

    const res = await request(h.app)
      .post(correction(filed.id))
      .send({
        replacement: {
          payee: 'Riverside Café',
          accountId: ALICE_ACCOUNTS.checking,
          categoryId: ALICE_ACCOUNTS.dining,
          amountMinor: '-2400',
        },
      });
    expect([200, 201]).toContain(res.status);

    expect(await bankTotal()).toBe(before);
  });

  it('writes the reversal and the replacement in one transaction, or neither', async () => {
    const filed = await filedEntry();
    const before = await h.db.entry.count();

    // The replacement names another owner's account, so it cannot be written —
    // and the reversal must not survive on its own.
    const doomed = (accountId: string): Promise<Response> =>
      request(h.app)
        .post(correction(filed.id))
        .send({
          replacement: {
            payee: 'Doomed replacement',
            accountId,
            categoryId: ALICE_ACCOUNTS.dining,
            amountMinor: '-2400',
          },
        });

    const res = await doomed(BLAKE_ACCOUNTS.checking);
    // Same answer as an account that does not exist at all: the response may
    // not confirm the decoy's row exists, which is the reason a foreign id is a
    // 404 rather than a 403. No source names a code for the payload case.
    const absent = await doomed('00000000-0000-4000-8000-0000000000aa');

    expect(res.status).toBe(absent.status);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(403);
    expect(expectProblem(res, res.status).type).toBe(
      expectProblem(absent, absent.status).type,
    );
    expect(await h.db.entry.count()).toBe(before);
    expect(
      await h.db.entry.count({ where: { reversesEntryId: filed.id } }),
    ).toBe(0);
  });

  it.each([
    ['a missing replacement', {}],
    ['a replacement whose lines do not sum to zero', {
      replacement: {
        lines: [
          { ledgerAccountId: ALICE_ACCOUNTS.dining, amountMinor: '2400' },
          { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-2000' },
        ],
      },
    }],
    ['a zero replacement amount', {
      replacement: {
        accountId: ALICE_ACCOUNTS.checking,
        categoryId: ALICE_ACCOUNTS.dining,
        amountMinor: '0',
      },
    }],
    ['a replacement amount as a JSON number', {
      replacement: {
        accountId: ALICE_ACCOUNTS.checking,
        categoryId: ALICE_ACCOUNTS.dining,
        amountMinor: -2400,
      },
    }],
    // A correction carries no date: both entries are dated today by definition.
    ['a caller-supplied date', {
      replacement: {
        occurredOn: '2020-01-01',
        accountId: ALICE_ACCOUNTS.checking,
        categoryId: ALICE_ACCOUNTS.dining,
        amountMinor: '-2400',
      },
      occurredOn: '2020-01-01',
    }],
  ])('rejects %s with a 400 problem+json', async (label, body) => {
    const filed = await filedEntry();

    const res = await request(h.app).post(correction(filed.id)).send(body);

    if (label === 'a caller-supplied date') {
      // An unknown key is stripped rather than rejected, but it must never
      // reach the ledger: both new entries are dated today regardless.
      if (res.status < 400) {
        const { reversal, replacement } = CorrectionResponse.parse(res.body);
        expect(reversal.occurredOn).toBe(todayIso());
        expect(replacement.occurredOn).toBe(todayIso());
        return;
      }
    }
    expectValidationProblem(res);
  });

  it('rejects a non-uuid id and 404s an id that does not exist', async () => {
    expectValidationProblem(
      await request(h.app)
        .post(correction('nope'))
        .send({
          replacement: {
            accountId: ALICE_ACCOUNTS.checking,
            categoryId: ALICE_ACCOUNTS.dining,
            amountMinor: '-100',
          },
        }),
      'id',
    );

    expectProblem(
      await request(h.app)
        .post(correction('00000000-0000-4000-8000-0000000000fc'))
        .send({
          replacement: {
            accountId: ALICE_ACCOUNTS.checking,
            categoryId: ALICE_ACCOUNTS.dining,
            amountMinor: '-100',
          },
        }),
      404,
    );
  });
});
