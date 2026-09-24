import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Entry, apiPath, routes, sumsToZero } from '@pfm/contracts';
import {
  ALICE,
  ALICE_ACCOUNTS,
  isoDaysAgo,
  startHarness,
  todayIso,
  uniqueName,
  type Harness,
} from '../../test/harness.js';
import { expectProblem, expectValidationProblem } from '../../test/problem.js';

const entries = apiPath(routes.entries);
const entry = (id: string): string => apiPath(routes.entry(id));

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

const lineFor = (
  posted: Entry,
  ledgerAccountId: string,
): Entry['lines'][number] => {
  const found = posted.lines.filter(
    (line) => line.ledgerAccountId === ledgerAccountId,
  );
  expect(found).toHaveLength(1);
  return found[0] as Entry['lines'][number];
};

describe('POST /entries — the simple form is sugar over the explicit one', () => {
  it('desugars into exactly two lines, the category line being the exact negation', async () => {
    const created = await post({
      occurredOn: isoDaysAgo(1),
      payee: 'Greenfield Grocers',
      description: 'Weekly shop',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.groceries,
      amountMinor: '-4200',
    });

    expect(created.lines).toHaveLength(2);
    expect(lineFor(created, ALICE_ACCOUNTS.checking).amountMinor).toBe(-4200n);
    expect(lineFor(created, ALICE_ACCOUNTS.groceries).amountMinor).toBe(4200n);
    expect(sumsToZero(created.lines)).toBe(true);
    expect(created.occurredOn).toBe(isoDaysAgo(1));
    expect(created.lockedAt).toBeNull();
    expect(created.reversesEntryId).toBeNull();
    expect(created.replacesEntryId).toBeNull();
    expect(created.reversedByEntryId).toBeNull();
  });

  it('carries no status field — reversal is a join, not a flag', async () => {
    const created = await post({
      occurredOn: todayIso(),
      payee: 'Noodle House',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-1800',
    });

    expect(Object.keys(created as unknown as object)).not.toContain('status');
  });
});

describe('POST /entries — the explicit form', () => {
  it('stores a three-line split exactly as posted and reads it back unchanged', async () => {
    const created = await post({
      occurredOn: isoDaysAgo(2),
      payee: 'Maple Street Hardware',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '3000' },
        { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '2000' },
        { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-5000' },
      ],
    });

    expect(created.lines).toHaveLength(3);
    expect(sumsToZero(created.lines)).toBe(true);

    const res = await request(h.app).get(entry(created.id));
    expect(res.status).toBe(200);
    const fetched = Entry.parse(res.body);

    expect(lineFor(fetched, ALICE_ACCOUNTS.household).amountMinor).toBe(3000n);
    expect(lineFor(fetched, ALICE_ACCOUNTS.groceries).amountMinor).toBe(2000n);
    expect(lineFor(fetched, ALICE_ACCOUNTS.checking).amountMinor).toBe(-5000n);
  });

  it('reports a liability line as it was posted', async () => {
    const created = await post({
      occurredOn: isoDaysAgo(3),
      payee: 'Streamline Media',
      lines: [
        // $50 of groceries on the credit card: expense positive, liability negative.
        { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '5000' },
        { ledgerAccountId: ALICE_ACCOUNTS.visa, amountMinor: '-5000' },
      ],
    });

    // ARCHITECTURE §4: "SUM(amount_minor) = 0 per entry", and the display flip
    // happens once — in TransactionRowView, the projection whose contract says
    // so. `Entry.lines` is the entry itself, and an entry sums to zero.
    expect(sumsToZero(created.lines)).toBe(true);
    expect(lineFor(created, ALICE_ACCOUNTS.visa).amountMinor).toBe(-5000n);
    expect(lineFor(created, ALICE_ACCOUNTS.visa).ledgerAccountKind).toBe(
      'liability',
    );
  });

  it('survives a read-modify-write cycle on a credit-card entry', async () => {
    // The edit form validates the lines it was given with the same contract the
    // API validates them with, so an entry the API hands out has to be an entry
    // the API takes back. A response the request schema rejects is a broken seam
    // whichever sign convention the response is meant to be in.
    const created = await post({
      occurredOn: isoDaysAgo(3),
      payee: 'Read-modify-write',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.dining, amountMinor: '2500' },
        { ledgerAccountId: ALICE_ACCOUNTS.visa, amountMinor: '-2500' },
      ],
    });

    const fetched = Entry.parse((await request(h.app).get(entry(created.id))).body);

    const res = await request(h.app)
      .patch(entry(created.id))
      .send({
        payee: 'Read-modify-write, edited',
        lines: fetched.lines.map((line) => ({
          ledgerAccountId: line.ledgerAccountId,
          amountMinor: line.amountMinor.toString(),
          projectId: line.projectId,
          excludedFromReporting: line.excludedFromReporting,
        })),
      });

    expect(res.status).toBe(200);
    const stored = await h.db.entryLine.findMany({
      where: { entryId: created.id },
      orderBy: { amountMinor: 'desc' },
    });
    expect(stored.map((line) => line.amountMinor)).toEqual([2500n, -2500n]);
  });

  it('accepts a transfer as an ordinary entry between two asset accounts', async () => {
    const created = await post({
      occurredOn: isoDaysAgo(4),
      payee: 'Transfer',
      lines: [
        { ledgerAccountId: ALICE_ACCOUNTS.savings, amountMinor: '20000' },
        { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-20000' },
      ],
    });

    expect(created.lines).toHaveLength(2);
    expect(sumsToZero(created.lines)).toBe(true);
  });
});

describe('POST /entries — every Zod rejection is a 400 problem+json', () => {
  const simple = {
    occurredOn: '2026-05-04',
    accountId: ALICE_ACCOUNTS.checking,
    categoryId: ALICE_ACCOUNTS.groceries,
    amountMinor: '-1000',
  };
  const explicit = {
    occurredOn: '2026-05-04',
    lines: [
      { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '1000' },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-1000' },
    ],
  };

  it.each([
    ['an empty body', {}],
    ['a missing date', { ...simple, occurredOn: undefined }],
    ['a timestamp where a calendar date belongs', { ...simple, occurredOn: '2026-05-04T10:00:00Z' }],
    ['a malformed date', { ...simple, occurredOn: '04/05/2026' }],
    ['a non-uuid accountId', { ...simple, accountId: 'checking' }],
    ['a zero amount', { ...simple, amountMinor: '0' }],
    ['a fractional amount', { ...simple, amountMinor: '12.34' }],
    ['a JSON number amount', { ...simple, amountMinor: 1234 }],
    ['an amount with a currency symbol', { ...simple, amountMinor: '$12' }],
    ['an over-long description', { ...simple, description: 'x'.repeat(201) }],
    ['an over-long payee', { ...simple, payee: 'x'.repeat(121) }],
    ['an over-long memo', { ...simple, memo: 'x'.repeat(501) }],
    ['lines that do not sum to zero', { ...explicit, lines: [
      { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '1000' },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-900' },
    ] }],
    ['a single line', { ...explicit, lines: [
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '1000' },
    ] }],
    ['an empty lines array', { ...explicit, lines: [] }],
    ['a zero line', { ...explicit, lines: [
      { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '0' },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '0' },
    ] }],
    ['a line with a JSON number amount', { ...explicit, lines: [
      { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: 1000 },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: -1000 },
    ] }],
    ['a non-uuid projectId', { ...explicit, lines: [
      { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '1000', projectId: 'house' },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-1000' },
    ] }],
    ['a non-boolean exclusion flag', { ...explicit, lines: [
      { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '1000', excludedFromReporting: 'yes' },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-1000' },
    ] }],
  ])('rejects %s', async (_label, body) => {
    const before = await h.db.entry.count();

    const res = await request(h.app).post(entries).send(body);

    expectValidationProblem(res);
    expect(await h.db.entry.count()).toBe(before);
  });
});

describe('POST /entries — line-level dimensions are meaningful only on income | expense lines', () => {
  it('refuses a projectId on an asset line and writes nothing', async () => {
    const project = await h.db.project.create({
      data: { ownerId: ALICE, name: uniqueName('Dimension guard') },
    });
    const before = await h.db.entry.count();

    const res = await request(h.app)
      .post(entries)
      .send({
        occurredOn: todayIso(),
        payee: 'Misplaced dimension',
        lines: [
          { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '1000' },
          {
            ledgerAccountId: ALICE_ACCOUNTS.checking,
            amountMinor: '-1000',
            projectId: project.id,
          },
        ],
      });

    // A well-formed request that breaks a business rule: 422, not a 400.
    const problem = expectProblem(res, 422);
    expect(JSON.stringify(problem).toLowerCase()).toContain('project');
    expect(await h.db.entry.count()).toBe(before);
  });

  it('refuses excludedFromReporting on a liability line and writes nothing', async () => {
    const before = await h.db.entry.count();

    const res = await request(h.app)
      .post(entries)
      .send({
        occurredOn: todayIso(),
        payee: 'Misplaced exclusion',
        lines: [
          { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '1000' },
          {
            ledgerAccountId: ALICE_ACCOUNTS.visa,
            amountMinor: '-1000',
            excludedFromReporting: true,
          },
        ],
      });

    const problem = expectProblem(res, 422);
    expect(JSON.stringify(problem).toLowerCase()).toMatch(/exclu/);
    expect(await h.db.entry.count()).toBe(before);
  });

  it('accepts both dimensions on an expense line', async () => {
    const created = await post({
      occurredOn: todayIso(),
      payee: 'The Copper Kettle',
      memo: 'Team lunch, half reimbursed',
      lines: [
        {
          ledgerAccountId: ALICE_ACCOUNTS.dining,
          amountMinor: '6000',
          excludedFromReporting: true,
        },
        { ledgerAccountId: ALICE_ACCOUNTS.dining, amountMinor: '4000' },
        { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-10000' },
      ],
    });

    const excluded = created.lines.filter((line) => line.excludedFromReporting);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]?.amountMinor).toBe(6000n);
  });
});

describe('GET /entries/:id', () => {
  it('rejects a non-uuid id with a 400 problem+json', async () => {
    const res = await request(h.app).get(entry('nope'));

    expectValidationProblem(res, 'id');
  });

  it('answers 404 for an id that does not exist', async () => {
    const res = await request(h.app).get(
      entry('00000000-0000-4000-8000-0000000000fd'),
    );

    expectProblem(res, 404);
  });
});

describe('PATCH and DELETE on an open entry', () => {
  it('patches the header and leaves the lines alone', async () => {
    const created = await post({
      occurredOn: isoDaysAgo(5),
      payee: 'Typo',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-2500',
    });

    const res = await request(h.app)
      .patch(entry(created.id))
      .send({ payee: 'Riverside Café' });

    expect(res.status).toBe(200);
    const patched = Entry.parse(res.body);
    expect(patched.payee).toBe('Riverside Café');
    expect(patched.lines).toHaveLength(2);
    expect(sumsToZero(patched.lines)).toBe(true);
  });

  it('rejects an empty patch with a 400 problem+json', async () => {
    const created = await post({
      occurredOn: isoDaysAgo(5),
      payee: 'Nothing to change',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-100',
    });

    const res = await request(h.app).patch(entry(created.id)).send({});

    expectValidationProblem(res);
  });

  it('rejects patched lines that do not sum to zero', async () => {
    const created = await post({
      occurredOn: isoDaysAgo(5),
      payee: 'Unbalanced patch',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-100',
    });

    const res = await request(h.app)
      .patch(entry(created.id))
      .send({
        lines: [
          { ledgerAccountId: ALICE_ACCOUNTS.dining, amountMinor: '100' },
          { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-90' },
        ],
      });

    expectValidationProblem(res, 'lines');
  });

  it('deletes an open entry, and its lines go with it', async () => {
    const created = await post({
      occurredOn: isoDaysAgo(6),
      payee: 'Mistake',
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.dining,
      amountMinor: '-900',
    });

    const res = await request(h.app).delete(entry(created.id));
    expect(res.status).toBe(204);

    expectProblem(await request(h.app).get(entry(created.id)), 404);
    expect(
      await h.db.entryLine.count({ where: { entryId: created.id } }),
    ).toBe(0);
  });
});
