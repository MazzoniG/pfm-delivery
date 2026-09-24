import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountList,
  CategoryList,
  ProjectList,
  TransactionPage,
  apiPath,
  routes,
} from '@pfm/contracts';
import { seedId } from '../../prisma/seed/ids.js';
import {
  ALICE,
  ALICE_ACCOUNTS,
  BLAKE,
  BLAKE_ACCOUNTS,
  BLAKE_PROJECT_ID,
  isoDaysAgo,
  reconcile,
  startHarness,
  todayIso,
  uniqueName,
  type Harness,
} from '../test/harness.js';
import { expectProblem } from '../test/problem.js';

// `owner_id` is decoration until something proves it. Two seeded tenants, and
// the decoy's rows are named so a leak shows up as a value in an assertion
// rather than as a count that is one too high.

const accounts = apiPath(routes.accounts);
const account = (id: string): string => apiPath(routes.account(id));
const categories = apiPath(routes.categories);
const entries = apiPath(routes.entries);
const entry = (id: string): string => apiPath(routes.entry(id));
const correction = (id: string): string => apiPath(routes.entryCorrection(id));
const projects = apiPath(routes.projects);
const project = (id: string): string => apiPath(routes.project(id));
const projectReport = (id: string): string => apiPath(routes.projectReport(id));

const ALICE_HOUSE_REMODEL = seedId(`project:${ALICE}:house-remodel`);
/** Wide enough to cover every seeded row of either tenant. */
const PROJECT_PERIOD = { from: isoDaysAgo(365), to: todayIso() };

let h: Harness;
let blakeEntryId: string;
let blakeLockedEntryId: string | null = null;

beforeAll(async () => {
  h = await startHarness();

  const blakeEntry = await h.db.entry.findFirstOrThrow({
    where: { ownerId: BLAKE },
    orderBy: { occurredOn: 'desc' },
  });
  blakeEntryId = blakeEntry.id;

  const locked = await h.db.entry.findFirst({
    where: { ownerId: BLAKE, lockedAt: { not: null } },
  });
  blakeLockedEntryId = locked?.id ?? null;
});

afterAll(async () => {
  await h.close();
});

describe('read isolation — nothing of the decoy reaches the demo tenant', () => {
  it('keeps the decoy out of GET /accounts', async () => {
    const list = AccountList.parse((await request(h.app).get(accounts)).body);

    expect(list.map((row) => row.name)).not.toContain('Reef Savings');
    expect(list.map((row) => row.id)).not.toContain(BLAKE_ACCOUNTS.checking);
    for (const row of list) {
      const owned = await h.db.ledgerAccount.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(owned.ownerId).toBe(ALICE);
    }
  });

  it('keeps the decoy out of GET /categories', async () => {
    const list = CategoryList.parse((await request(h.app).get(categories)).body);

    expect(list.map((row) => row.name)).not.toContain('Reef Supplies');
    expect(list.map((row) => row.name)).not.toContain('Reef Frag Sales');
    expect(list.map((row) => row.id)).not.toContain(BLAKE_ACCOUNTS.spending);
    for (const row of list) {
      const owned = await h.db.ledgerAccount.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(owned.ownerId).toBe(ALICE);
    }
  });

  // KNOWN GAP, deliberately left as a branch. No source of truth says whether a
  // list scoped to an unreachable account is an empty page or a 404: the
  // 404-not-403 rule is stated for a fetch, patch or delete of a foreign *id*,
  // and `EntryListQuery.accountId` is a filter rather than the addressed
  // resource. Both readings are safe here — neither returns a decoy row — so
  // the test pins the property both share and names the open question instead
  // of resolving it. Resolve it in the contract, then tighten this.
  it('never serves the decoy register — either an empty page or a 404, contract does not say which', async () => {
    const res = await request(h.app)
      .get(entries)
      .query({ accountId: BLAKE_ACCOUNTS.checking });

    if (res.status === 200) {
      const page = TransactionPage.parse(res.body);
      expect(page.data).toEqual([]);
    } else {
      expectProblem(res, 404);
    }
  });

  it('never leaks a decoy payee into the demo register', async () => {
    const page = TransactionPage.parse(
      (
        await request(h.app)
          .get(entries)
          .query({ accountId: ALICE_ACCOUNTS.checking, limit: 200 })
      ).body,
    );

    for (const row of page.data) {
      expect(row.payee ?? '').not.toContain('REEF');
    }
  });

  it('answers 404 — never 403 — for a fetch of the decoy’s entry', async () => {
    const res = await request(h.app).get(entry(blakeEntryId));

    // A 403 would confirm the row exists. Ownership is a WHERE clause.
    expectProblem(res, 404);
  });

  it('answers 404 for a PATCH of the decoy’s entry, and changes nothing', async () => {
    const before = await h.db.entry.findUniqueOrThrow({
      where: { id: blakeEntryId },
    });

    const res = await request(h.app)
      .patch(entry(blakeEntryId))
      .send({ payee: 'Rewritten by another tenant' });

    expectProblem(res, 404);
    expect(
      await h.db.entry.findUniqueOrThrow({ where: { id: blakeEntryId } }),
    ).toEqual(before);
  });

  it('answers 404 for a PATCH of the decoy’s lines, and leaves them intact', async () => {
    // The `lines` branch replaces an entry's lines wholesale. A miss here does
    // not merely read another tenant's entry — it deletes and rewrites it. The
    // payload is entirely valid and entirely Alice's, so nothing but ownership
    // can reject it.
    const before = await h.db.entryLine.findMany({
      where: { entryId: blakeEntryId },
      orderBy: { amountMinor: 'asc' },
    });
    expect(before.length).toBeGreaterThanOrEqual(2);

    const res = await request(h.app)
      .patch(entry(blakeEntryId))
      .send({
        payee: 'Rewritten by another tenant',
        lines: [
          { ledgerAccountId: ALICE_ACCOUNTS.groceries, amountMinor: '1234' },
          { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-1234' },
        ],
      });

    expectProblem(res, 404);

    const after = await h.db.entryLine.findMany({
      where: { entryId: blakeEntryId },
      orderBy: { amountMinor: 'asc' },
    });
    expect(after).toHaveLength(before.length);
    expect(after.map((line) => line.amountMinor)).toEqual(
      before.map((line) => line.amountMinor),
    );
    expect(after.map((line) => line.ledgerAccountId)).toEqual(
      before.map((line) => line.ledgerAccountId),
    );
    expect(after.reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(0n);
    // None of Alice's accounts may appear on the decoy's entry.
    expect(after.map((line) => line.ledgerAccountId)).not.toContain(
      ALICE_ACCOUNTS.groceries,
    );
  });

  it('answers 404 for a DELETE of the decoy’s entry, and deletes nothing', async () => {
    const res = await request(h.app).delete(entry(blakeEntryId));

    expectProblem(res, 404);
    expect(
      await h.db.entry.findUnique({ where: { id: blakeEntryId } }),
    ).not.toBeNull();
  });

  it('answers 404 for a correction against the decoy’s entry', async () => {
    const target = blakeLockedEntryId ?? blakeEntryId;
    const before = await h.db.entry.count();

    const res = await request(h.app)
      .post(correction(target))
      .send({
        replacement: {
          accountId: ALICE_ACCOUNTS.checking,
          categoryId: ALICE_ACCOUNTS.dining,
          amountMinor: '-100',
        },
      });

    expectProblem(res, 404);
    expect(await h.db.entry.count()).toBe(before);
  });

  it('answers 404 for a PATCH of the decoy’s account, and renames nothing', async () => {
    const res = await request(h.app)
      .patch(account(BLAKE_ACCOUNTS.checking))
      .send({ name: 'Renamed by another tenant' });

    expectProblem(res, 404);
    const row = await h.db.ledgerAccount.findUniqueOrThrow({
      where: { id: BLAKE_ACCOUNTS.checking },
    });
    expect(row.name).toBe('Reef Savings');
  });

  it('keeps the decoy’s project out of GET /projects', async () => {
    const res = await request(h.app).get(projects);
    const list = ProjectList.parse(res.body);

    expect(list.map((row) => row.id)).not.toContain(BLAKE_PROJECT_ID);
    expect(JSON.stringify(res.body)).not.toMatch(/reef/i);
    for (const row of list) {
      const owned = await h.db.project.findUniqueOrThrow({ where: { id: row.id } });
      expect(owned.ownerId).toBe(ALICE);
    }
  });

  it('keeps the decoy’s lines out of the demo tenant’s project figures', async () => {
    // Blake's two project lines carry 6,666.66; none of it may reach a sum here.
    const list = ProjectList.parse((await request(h.app).get(projects)).body);
    for (const row of list) {
      const lines = await h.db.entryLine.findMany({
        where: { projectId: row.id, excludedFromReporting: false, entry: { ownerId: ALICE } },
        select: { amountMinor: true, entryId: true },
      });
      expect(row.netCostMinor).toBe(lines.reduce((sum, line) => sum + line.amountMinor, 0n));
      expect(row.transactionCount).toBe(new Set(lines.map((line) => line.entryId)).size);
    }
  });

  it('answers 404 — never 403 — for the report of the decoy’s project', async () => {
    const res = await request(h.app).get(projectReport(BLAKE_PROJECT_ID)).query(PROJECT_PERIOD);

    expectProblem(res, 404);
    expect(JSON.stringify(res.body)).not.toMatch(/reef/i);
    expect(res.body).not.toHaveProperty('transactionCount');
  });

  it('answers 404 for a PATCH of the decoy’s project, and renames nothing', async () => {
    const res = await request(h.app)
      .patch(project(BLAKE_PROJECT_ID))
      .send({ name: 'Renamed by another tenant' });

    expectProblem(res, 404);
    const row = await h.db.project.findUniqueOrThrow({ where: { id: BLAKE_PROJECT_ID } });
    expect(row.name).toBe('Reef tank');
  });

  it('answers 404 for a DELETE of the decoy’s project — not the 409 whose count would confirm it', async () => {
    const res = await request(h.app).delete(project(BLAKE_PROJECT_ID));

    expectProblem(res, 404);
    expect(res.body).not.toHaveProperty('transactionCount');
    expect(await h.db.project.findUnique({ where: { id: BLAKE_PROJECT_ID } })).not.toBeNull();
  });

  it('answers the register filtered by the decoy’s project with an empty page and a zero count', async () => {
    for (const accountId of [ALICE_ACCOUNTS.checking, ALICE_ACCOUNTS.visa]) {
      const res = await request(h.app)
        .get(entries)
        .query({ accountId, projectId: BLAKE_PROJECT_ID });

      expect(res.status).toBe(200);
      const page = TransactionPage.parse(res.body);
      expect(page.data).toEqual([]);
      // Blake's project has entries in "other accounts"; counting them would leak.
      expect(page.projectEntriesInOtherAccounts).toBe(0);
      expect(JSON.stringify(res.body)).not.toMatch(/reef/i);
    }
  });

  it('answers 404 for a DELETE of the decoy’s account, and archives nothing', async () => {
    const res = await request(h.app).delete(account(BLAKE_ACCOUNTS.checking));

    expectProblem(res, 404);
    const row = await h.db.ledgerAccount.findUniqueOrThrow({
      where: { id: BLAKE_ACCOUNTS.checking },
    });
    expect(row.archivedAt).toBeNull();
  });
});

describe('write isolation — an FK proves the row exists, not that the caller may use it', () => {
  const countEntries = (): Promise<number> => h.db.entry.count();

  /** A syntactically valid id that belongs to nobody. */
  const NOBODY = '00000000-0000-4000-8000-0000000000ab';

  /**
   * A reference to another owner's row and a reference to a row that does not
   * exist must be answered identically. That is the stated reason the foreign
   * *path* id is a 404 and not a 403 — the response may not confirm the row
   * exists — and a payload naming another owner's account asks the same
   * question through the body. No source of truth names a status code for the
   * payload case, so what is pinned here is the property that is stated:
   * one answer for both, never 403, never a 5xx, and nothing of the decoy in
   * the body.
   */
  const expectIndistinguishable = (
    foreign: Response,
    absent: Response,
  ): void => {
    expect(foreign.status).toBe(absent.status);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.status).toBeLessThan(500);
    expect(foreign.status).not.toBe(403);

    const problem = expectProblem(foreign, foreign.status);
    expect(problem.type).toBe(expectProblem(absent, absent.status).type);
    expect(JSON.stringify(problem)).not.toContain('Reef');
  };

  const postEntry = (
    payee: string,
    body: Record<string, unknown>,
  ): Promise<Response> =>
    request(h.app)
      .post(entries)
      .send({ occurredOn: todayIso(), payee, ...body });

  it('refuses an entry whose line names the decoy’s account', async () => {
    const before = await countEntries();
    const lines = (other: string): Record<string, unknown>[] => [
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-5000' },
      { ledgerAccountId: other, amountMinor: '5000' },
    ];

    expectIndistinguishable(
      await postEntry('Cross-tenant line', {
        lines: lines(BLAKE_ACCOUNTS.spending),
      }),
      await postEntry('Absent line', { lines: lines(NOBODY) }),
    );
    expect(await countEntries()).toBe(before);
  });

  it('refuses the simple form when the category belongs to the decoy', async () => {
    const before = await countEntries();

    expectIndistinguishable(
      await postEntry('Cross-tenant category', {
        accountId: ALICE_ACCOUNTS.checking,
        categoryId: BLAKE_ACCOUNTS.spending,
        amountMinor: '-5000',
      }),
      await postEntry('Absent category', {
        accountId: ALICE_ACCOUNTS.checking,
        categoryId: NOBODY,
        amountMinor: '-5000',
      }),
    );
    expect(await countEntries()).toBe(before);
  });

  it('refuses the simple form when the account belongs to the decoy', async () => {
    const before = await countEntries();

    expectIndistinguishable(
      await postEntry('Cross-tenant account', {
        accountId: BLAKE_ACCOUNTS.checking,
        categoryId: ALICE_ACCOUNTS.dining,
        amountMinor: '-5000',
      }),
      await postEntry('Absent account', {
        accountId: NOBODY,
        categoryId: ALICE_ACCOUNTS.dining,
        amountMinor: '-5000',
      }),
    );
    expect(await countEntries()).toBe(before);
  });

  it('refuses a line assigned to the decoy’s project', async () => {
    const before = await countEntries();
    const lines = (projectId: string): Record<string, unknown>[] => [
      {
        ledgerAccountId: ALICE_ACCOUNTS.groceries,
        amountMinor: '5000',
        projectId,
      },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-5000' },
    ];

    expectIndistinguishable(
      await postEntry('Cross-tenant project', {
        lines: lines(BLAKE_PROJECT_ID),
      }),
      await postEntry('Absent project', { lines: lines(NOBODY) }),
    );
    expect(await countEntries()).toBe(before);
  });

  it('refuses the simple form when its projectId belongs to the decoy', async () => {
    const before = await countEntries();
    const body = (projectId: string): Record<string, unknown> => ({
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.household,
      amountMinor: '-5000',
      projectId,
    });

    expectIndistinguishable(
      await postEntry('Cross-tenant simple project', body(BLAKE_PROJECT_ID)),
      await postEntry('Absent simple project', body(NOBODY)),
    );
    expect(await countEntries()).toBe(before);
    expect(
      await h.db.entryLine.count({
        where: { projectId: BLAKE_PROJECT_ID, entry: { ownerId: ALICE } },
      }),
    ).toBe(0);
  });

  it('refuses a patch that moves a line onto the decoy’s project', async () => {
    const target = async (): Promise<string> => {
      const created = await postEntry('Project patch target', {
        accountId: ALICE_ACCOUNTS.checking,
        categoryId: ALICE_ACCOUNTS.household,
        amountMinor: '-1500',
      });
      expect([200, 201]).toContain(created.status);
      return (created.body as { id: string }).id;
    };
    const lines = (projectId: string): Record<string, unknown>[] => [
      { ledgerAccountId: ALICE_ACCOUNTS.household, amountMinor: '1500', projectId },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-1500' },
    ];

    const foreignTarget = await target();
    const absentTarget = await target();

    expectIndistinguishable(
      await request(h.app).patch(entry(foreignTarget)).send({ lines: lines(BLAKE_PROJECT_ID) }),
      await request(h.app).patch(entry(absentTarget)).send({ lines: lines(NOBODY) }),
    );
    for (const id of [foreignTarget, absentTarget]) {
      const lineRows = await h.db.entryLine.findMany({ where: { entryId: id } });
      expect(lineRows).toHaveLength(2);
      expect(lineRows.every((line) => line.projectId === null)).toBe(true);
    }
  });

  it('refuses a correction whose replacement names the decoy’s project, posting neither half', async () => {
    const filed = async (): Promise<string> => {
      const created = await postEntry('Filed for correction', {
        occurredOn: isoDaysAgo(40),
        accountId: ALICE_ACCOUNTS.checking,
        categoryId: ALICE_ACCOUNTS.household,
        amountMinor: '-1500',
      });
      expect([200, 201]).toContain(created.status);
      const id = (created.body as { id: string }).id;
      await reconcile(h.db, id);
      return id;
    };
    const replacement = (projectId: string): Record<string, unknown> => ({
      replacement: {
        accountId: ALICE_ACCOUNTS.checking,
        categoryId: ALICE_ACCOUNTS.household,
        amountMinor: '-1500',
        projectId,
      },
    });

    const foreignTarget = await filed();
    const absentTarget = await filed();
    const before = await countEntries();

    expectIndistinguishable(
      await request(h.app).post(correction(foreignTarget)).send(replacement(BLAKE_PROJECT_ID)),
      await request(h.app).post(correction(absentTarget)).send(replacement(NOBODY)),
    );
    expect(await countEntries()).toBe(before);
  });

  it('refuses a patch that moves a line onto the decoy’s account', async () => {
    const target = async (): Promise<string> => {
      const created = await postEntry('Patch target', {
        accountId: ALICE_ACCOUNTS.checking,
        categoryId: ALICE_ACCOUNTS.dining,
        amountMinor: '-1500',
      });
      expect([200, 201]).toContain(created.status);
      return (created.body as { id: string }).id;
    };
    const lines = (other: string): Record<string, unknown>[] => [
      { ledgerAccountId: other, amountMinor: '1500' },
      { ledgerAccountId: ALICE_ACCOUNTS.checking, amountMinor: '-1500' },
    ];

    const foreignTarget = await target();
    const absentTarget = await target();

    const foreign = await request(h.app)
      .patch(entry(foreignTarget))
      .send({ lines: lines(BLAKE_ACCOUNTS.spending) });
    const absent = await request(h.app)
      .patch(entry(absentTarget))
      .send({ lines: lines(NOBODY) });

    expectIndistinguishable(foreign, absent);

    for (const id of [foreignTarget, absentTarget]) {
      const lineRows = await h.db.entryLine.findMany({ where: { entryId: id } });
      expect(lineRows).toHaveLength(2);
      expect(lineRows.map((line) => line.ledgerAccountId)).not.toContain(
        BLAKE_ACCOUNTS.spending,
      );
      expect(lineRows.reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(0n);
    }
  });
});

describe('the seam works in both directions', () => {
  it('serves the decoy its own rows and none of the demo tenant’s', async () => {
    const asBlake = await h.as(BLAKE);

    const list = AccountList.parse((await request(asBlake).get(accounts)).body);
    expect(list.map((row) => row.name)).toContain('Reef Savings');
    expect(list.map((row) => row.id)).not.toContain(ALICE_ACCOUNTS.checking);
    expect(list.map((row) => row.name)).not.toContain('Everyday Checking');

    const cats = CategoryList.parse(
      (await request(asBlake).get(categories)).body,
    );
    expect(cats.map((row) => row.name)).toContain('Reef Supplies');
    expect(cats.map((row) => row.name)).not.toContain('Groceries');
  });

  it('serves the decoy its own project and none of the demo tenant’s', async () => {
    const asBlake = await h.as(BLAKE);

    const list = ProjectList.parse((await request(asBlake).get(projects)).body);
    expect(list.map((row) => row.name)).toContain('Reef tank');
    expect(list.map((row) => row.id)).not.toContain(ALICE_HOUSE_REMODEL);
    expect(list.map((row) => row.name)).not.toContain('House remodel');

    expectProblem(
      await request(asBlake).get(projectReport(ALICE_HOUSE_REMODEL)).query(PROJECT_PERIOD),
      404,
    );

    const page = TransactionPage.parse(
      (
        await request(asBlake)
          .get(entries)
          .query({ accountId: BLAKE_ACCOUNTS.checking, projectId: ALICE_HOUSE_REMODEL })
      ).body,
    );
    expect(page.data).toEqual([]);
    expect(page.projectEntriesInOtherAccounts).toBe(0);
  });

  it('hides a freshly created project from the other tenant', async () => {
    const created = await request(h.app)
      .post(projects)
      .send({ name: uniqueName('Private project') });
    expect([200, 201]).toContain(created.status);
    const id = (created.body as { id: string }).id;

    const asBlake = await h.as(BLAKE);
    const list = ProjectList.parse((await request(asBlake).get(projects)).body);
    expect(list.map((row) => row.id)).not.toContain(id);
    expectProblem(await request(asBlake).patch(project(id)).send({ name: 'Taken' }), 404);
    expectProblem(await request(asBlake).delete(project(id)), 404);
    expect(await h.db.project.findUnique({ where: { id } })).not.toBeNull();
  });

  it('hides a freshly created account from the other tenant', async () => {
    const name = uniqueName('Private to Alice');
    const created = await request(h.app)
      .post(accounts)
      .send({ name, kind: 'asset' });
    expect([200, 201]).toContain(created.status);
    const id = (created.body as { id: string }).id;

    const asBlake = await h.as(BLAKE);
    const list = AccountList.parse((await request(asBlake).get(accounts)).body);
    expect(list.map((row) => row.id)).not.toContain(id);

    expectProblem(
      await request(asBlake).patch(account(id)).send({ name: 'Taken' }),
      404,
    );
  });
});
