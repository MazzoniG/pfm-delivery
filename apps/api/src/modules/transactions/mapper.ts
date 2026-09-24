import {
  minorUnitsToString,
  type EntryLineWire,
  type EntryRef,
  type EntryWire,
  type TransactionRowViewWire,
} from '@pfm/contracts';
import { forDisplay } from '../../shared/ledger/display-sign.js';
import type { EntryRow, LineRow } from './repository.js';

const calendarDate = (date: Date): string => date.toISOString().slice(0, 10);

const ref = (
  entry: { id: string; occurredOn: Date } | undefined | null,
): EntryRef | null =>
  entry ? { id: entry.id, occurredOn: calendarDate(entry.occurredOn) } : null;

/**
 * The two sides of the sign boundary, and they are deliberately different.
 *
 * `asPosted` is the ledger as stored: an entry's own lines sum to zero, which
 * is the invariant the deferrable trigger enforces and the one a caller can
 * hand straight back to `PATCH`. `forDisplay` belongs to the register row — a
 * projection, whose contract says it already carries its display sign.
 *
 * An entry is not a view of the ledger; it is the ledger. See ADR-014.
 */
const asPosted = (line: LineRow): string => minorUnitsToString(line.amountMinor);

const asDisplayed = (line: LineRow): string =>
  minorUnitsToString(forDisplay(line.amountMinor, line.ledgerAccount.kind));

const toEntryLine = (line: LineRow): EntryLineWire => ({
  id: line.id,
  ledgerAccountId: line.ledgerAccountId,
  ledgerAccountName: line.ledgerAccount.name,
  ledgerAccountKind: line.ledgerAccount.kind,
  amountMinor: asPosted(line),
  projectId: line.projectId,
  excludedFromReporting: line.excludedFromReporting,
  reconciledAt: line.reconciledAt?.toISOString() ?? null,
});

export const toEntry = (row: EntryRow): EntryWire => ({
  id: row.id,
  occurredOn: calendarDate(row.occurredOn),
  description: row.description,
  payee: row.payee,
  memo: row.memo,
  lockedAt: row.lockedAt?.toISOString() ?? null,
  reversesEntryId: row.reversesEntryId,
  replacesEntryId: row.replacesEntryId,
  reversedByEntryId: row.reversedBy[0]?.id ?? null,
  recordedAt: row.recordedAt.toISOString(),
  lines: row.lines.map(toEntryLine),
});

/**
 * Raw signed, like the project's net cost, and over every line the entry
 * assigns to the project — excluded ones too, since the register shows what
 * moved, not what is reported.
 */
const projectShare = (row: EntryRow, projectId: string): string =>
  minorUnitsToString(
    row.lines
      .filter((line) => line.projectId === projectId)
      .reduce((total, line) => total + line.amountMinor, 0n),
  );

/**
 * An entry seen from one account: that account's line, with the counter-side
 * collapsed. Exactly one counter line shows itself — a category, or the other
 * account when the entry is a transfer. More than one collapses to a split,
 * because a single cell cannot honestly summarise two categories.
 */
export const toRowViews = (
  row: EntryRow,
  ledgerAccountId: string,
  projectId?: string,
): TransactionRowViewWire[] =>
  row.lines
    .filter((line) => line.ledgerAccountId === ledgerAccountId)
    .map((line) => {
      const counter = row.lines.filter((other) => other.id !== line.id);
      const only = counter.length === 1 ? counter[0] : undefined;

      return {
        entryId: row.id,
        lineId: line.id,
        occurredOn: calendarDate(row.occurredOn),
        payee: row.payee,
        description: row.description,
        amountMinor: asDisplayed(line),
        lockedAt: row.lockedAt?.toISOString() ?? null,
        reconciledAt: line.reconciledAt?.toISOString() ?? null,
        counterparty: only
          ? {
              kind: 'single' as const,
              ledgerAccountId: only.ledgerAccountId,
              name: only.ledgerAccount.name,
              ledgerAccountKind: only.ledgerAccount.kind,
              projectId: only.projectId,
              excludedFromReporting: only.excludedFromReporting,
            }
          : { kind: 'split' as const },
        reverses: ref(row.reverses),
        reversedBy: ref(row.reversedBy[0]),
        replaces: ref(row.replaces),
        ...(projectId ? { projectShareMinor: projectShare(row, projectId) } : {}),
      };
    });
