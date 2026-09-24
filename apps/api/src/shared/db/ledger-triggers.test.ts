import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALICE,
  ALICE_ACCOUNTS,
  connectRaw,
  isoDaysAgo,
  startHarness,
  type Harness,
} from '../../test/harness.js';

// The invariants live in the database, not in the service layer. A mocked
// client cannot prove a deferrable constraint trigger fires at COMMIT, so
// everything here goes through a raw connection that owns its own transaction
// boundaries — which is also how a migration or a future developer bypassing
// the repository would reach these tables.

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

const insertEntry = async (
  client: Client,
  payee: string,
  lockedAt: string | null = null,
): Promise<string> => {
  const res = await client.query<{ id: string }>(
    `INSERT INTO entries (owner_id, occurred_on, payee, locked_at)
     VALUES ($1, $2::date, $3, $4::timestamptz) RETURNING id`,
    [ALICE, isoDaysAgo(3), payee, lockedAt],
  );
  return res.rows[0]?.id as string;
};

const insertLine = async (
  client: Client,
  entryId: string,
  ledgerAccountId: string,
  amountMinor: string,
): Promise<string> => {
  const res = await client.query<{ id: string }>(
    `INSERT INTO entry_lines (entry_id, ledger_account_id, amount_minor)
     VALUES ($1, $2, $3::bigint) RETURNING id`,
    [entryId, ledgerAccountId, amountMinor],
  );
  return res.rows[0]?.id as string;
};

describe('the zero-sum invariant is deferred to COMMIT', () => {
  it('lets an unbalanced entry exist mid-transaction and refuses it at COMMIT', async () => {
    const client = await connectRaw();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client, 'Deferred zero-sum');

      // The insert itself must succeed: both legs of an entry cannot be
      // written in one statement, so an immediate check would make an ordinary
      // ledger write impossible.
      await expect(
        insertLine(client, entryId, ALICE_ACCOUNTS.groceries, '100'),
      ).resolves.toBeTruthy();

      await expect(client.query('COMMIT')).rejects.toThrow();

      const survived = await h.db.entry.findUnique({ where: { id: entryId } });
      expect(survived).toBeNull();
    } finally {
      await client.end();
    }
  });

  it('accepts both legs written as separate statements in one transaction', async () => {
    const client = await connectRaw();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client, 'Balanced in two statements');
      await insertLine(client, entryId, ALICE_ACCOUNTS.groceries, '2500');
      await insertLine(client, entryId, ALICE_ACCOUNTS.checking, '-2500');
      await client.query('COMMIT');

      expect(
        await h.db.entry.findUnique({ where: { id: entryId } }),
      ).not.toBeNull();

      await h.db.entry.delete({ where: { id: entryId } });
    } finally {
      await client.end();
    }
  });

  it('refuses an update that unbalances an entry', async () => {
    const client = await connectRaw();
    let entryId = '';
    try {
      await client.query('BEGIN');
      entryId = await insertEntry(client, 'Unbalancing update');
      await insertLine(client, entryId, ALICE_ACCOUNTS.groceries, '2500');
      await insertLine(client, entryId, ALICE_ACCOUNTS.checking, '-2500');
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(
        'UPDATE entry_lines SET amount_minor = 9999 WHERE entry_id = $1 AND amount_minor = 2500',
        [entryId],
      );
      await expect(client.query('COMMIT')).rejects.toThrow();

      const lines = await h.db.entryLine.findMany({ where: { entryId } });
      expect(lines.map((line) => line.amountMinor).sort()).toEqual([
        -2500n,
        2500n,
      ]);
    } finally {
      await client.end();
      if (entryId !== '') {
        await h.db.entry.deleteMany({ where: { id: entryId } });
      }
    }
  });

  it('refuses the deletion of a single line of a balanced entry', async () => {
    const client = await connectRaw();
    let entryId = '';
    try {
      await client.query('BEGIN');
      entryId = await insertEntry(client, 'Half-deleted entry');
      await insertLine(client, entryId, ALICE_ACCOUNTS.groceries, '1500');
      await insertLine(client, entryId, ALICE_ACCOUNTS.checking, '-1500');
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(
        'DELETE FROM entry_lines WHERE entry_id = $1 AND amount_minor = 1500',
        [entryId],
      );
      await expect(client.query('COMMIT')).rejects.toThrow();

      expect(await h.db.entryLine.count({ where: { entryId } })).toBe(2);
    } finally {
      await client.end();
      if (entryId !== '') {
        await h.db.entry.deleteMany({ where: { id: entryId } });
      }
    }
  });
});

describe('the lock trigger refuses every write to a reconciled entry', () => {
  const lockedEntry = async (): Promise<string> => {
    const client = await connectRaw();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client, 'Filed entry');
      await insertLine(client, entryId, ALICE_ACCOUNTS.groceries, '3300');
      await insertLine(client, entryId, ALICE_ACCOUNTS.checking, '-3300');
      await client.query('COMMIT');

      await client.query(
        `UPDATE entry_lines SET reconciled_at = now() WHERE entry_id = $1`,
        [entryId],
      );
      await client.query(
        `UPDATE entries SET locked_at = now() WHERE id = $1`,
        [entryId],
      );
      return entryId;
    } finally {
      await client.end();
    }
  };

  it('raises on UPDATE of the entry', async () => {
    const entryId = await lockedEntry();

    await expect(
      raw.query('UPDATE entries SET payee = $2 WHERE id = $1', [
        entryId,
        'Edited behind the service',
      ]),
    ).rejects.toThrow();

    const row = await h.db.entry.findUniqueOrThrow({ where: { id: entryId } });
    expect(row.payee).toBe('Filed entry');
  });

  it('raises on DELETE of the entry', async () => {
    const entryId = await lockedEntry();

    await expect(
      raw.query('DELETE FROM entries WHERE id = $1', [entryId]),
    ).rejects.toThrow();

    expect(await h.db.entry.findUnique({ where: { id: entryId } })).not.toBeNull();
  });

  it('raises on UPDATE of a line — the money is on the lines', async () => {
    const entryId = await lockedEntry();

    await expect(
      raw.query(
        'UPDATE entry_lines SET amount_minor = -amount_minor WHERE entry_id = $1',
        [entryId],
      ),
    ).rejects.toThrow();

    const lines = await h.db.entryLine.findMany({ where: { entryId } });
    expect(lines.map((line) => line.amountMinor).sort()).toEqual([-3300n, 3300n]);
  });

  it('raises on INSERT of a line into a locked entry', async () => {
    const entryId = await lockedEntry();

    await expect(
      raw.query(
        `INSERT INTO entry_lines (entry_id, ledger_account_id, amount_minor)
         VALUES ($1, $2, 0)`,
        [entryId, ALICE_ACCOUNTS.dining],
      ),
    ).rejects.toThrow();

    expect(await h.db.entryLine.count({ where: { entryId } })).toBe(2);
  });

  it('raises on DELETE of a line of a locked entry', async () => {
    const entryId = await lockedEntry();

    await expect(
      raw.query('DELETE FROM entry_lines WHERE entry_id = $1', [entryId]),
    ).rejects.toThrow();

    expect(await h.db.entryLine.count({ where: { entryId } })).toBe(2);
  });

  it('allows the write that sets the lock, and every write before it', async () => {
    const client = await connectRaw();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client, 'Still open');
      await insertLine(client, entryId, ALICE_ACCOUNTS.groceries, '700');
      await insertLine(client, entryId, ALICE_ACCOUNTS.checking, '-700');
      await client.query('COMMIT');

      await client.query('UPDATE entries SET payee = $2 WHERE id = $1', [
        entryId,
        'Edited while open',
      ]);
      await client.query(
        'UPDATE entry_lines SET reconciled_at = now() WHERE entry_id = $1',
        [entryId],
      );
      await client.query('UPDATE entries SET locked_at = now() WHERE id = $1', [
        entryId,
      ]);

      const row = await h.db.entry.findUniqueOrThrow({ where: { id: entryId } });
      expect(row.payee).toBe('Edited while open');
      expect(row.lockedAt).not.toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('the audit trigger records every write, including ones that bypass the service', () => {
  const auditRows = async (
    entryId: string,
  ): Promise<{ sourceTable: string; action: string; before: unknown; after: unknown }[]> =>
    (
      await h.db.entryAuditLog.findMany({
        where: { entryId },
        orderBy: { changedAt: 'asc' },
      })
    ).map((row) => ({
      sourceTable: row.sourceTable,
      action: row.action.toUpperCase(),
      before: row.before,
      after: row.after,
    }));

  it('logs the insert of an entry and of its lines', async () => {
    const client = await connectRaw();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client, 'Audited insert');
      await insertLine(client, entryId, ALICE_ACCOUNTS.groceries, '1200');
      await insertLine(client, entryId, ALICE_ACCOUNTS.checking, '-1200');
      await client.query('COMMIT');

      const rows = await auditRows(entryId);
      const inserts = rows.filter((row) => row.action === 'INSERT');

      expect(inserts.filter((row) => row.sourceTable === 'entries')).toHaveLength(1);
      // A log that watched only `entries` would not record that the money moved.
      expect(
        inserts.filter((row) => row.sourceTable === 'entry_lines'),
      ).toHaveLength(2);
      for (const row of inserts) {
        expect(row.after).not.toBeNull();
      }

      await h.db.entry.delete({ where: { id: entryId } });
    } finally {
      await client.end();
    }
  });

  it('logs a raw SQL update with both the before and the after', async () => {
    const client = await connectRaw();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client, 'Before the edit');
      await insertLine(client, entryId, ALICE_ACCOUNTS.groceries, '4400');
      await insertLine(client, entryId, ALICE_ACCOUNTS.checking, '-4400');
      await client.query('COMMIT');

      await client.query('UPDATE entries SET payee = $2 WHERE id = $1', [
        entryId,
        'After the edit',
      ]);

      const updates = (await auditRows(entryId)).filter(
        (row) => row.action === 'UPDATE' && row.sourceTable === 'entries',
      );
      expect(updates).toHaveLength(1);
      expect((updates[0]?.before as { payee: string }).payee).toBe('Before the edit');
      expect((updates[0]?.after as { payee: string }).payee).toBe('After the edit');

      await h.db.entry.delete({ where: { id: entryId } });
    } finally {
      await client.end();
    }
  });

  it('keeps the audit trail standing after the entry is deleted outright', async () => {
    const client = await connectRaw();
    let entryId = '';
    try {
      await client.query('BEGIN');
      entryId = await insertEntry(client, 'Deleted outright');
      await insertLine(client, entryId, ALICE_ACCOUNTS.groceries, '800');
      await insertLine(client, entryId, ALICE_ACCOUNTS.checking, '-800');
      await client.query('COMMIT');

      await client.query('DELETE FROM entries WHERE id = $1', [entryId]);
    } finally {
      await client.end();
    }

    expect(await h.db.entry.findUnique({ where: { id: entryId } })).toBeNull();

    const rows = await auditRows(entryId);
    const deletes = rows.filter((row) => row.action === 'DELETE');
    // No FK on entry_id, deliberately: the orphaned row is the one worth keeping.
    expect(deletes.filter((row) => row.sourceTable === 'entries')).toHaveLength(1);
    expect(deletes.filter((row) => row.sourceTable === 'entry_lines')).toHaveLength(2);
    expect(deletes[0]?.before).not.toBeNull();
  });
});
