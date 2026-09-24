import type { Prisma } from '@prisma/client';
import { seedId } from './ids.js';
import { atHour } from './time.js';

export type LineDraft = {
  ledgerAccountId: string;
  amountMinor: bigint;
  projectId?: string;
  excludedFromReporting?: boolean;
};

export type EntryDraft = {
  key: string;
  occurredOn: Date;
  payee?: string;
  memo?: string;
  lines: readonly LineDraft[];
  reversesKey?: string;
  replacesKey?: string;
};

export type Ledger = {
  post(draft: EntryDraft): string;
  entries: Prisma.EntryCreateManyInput[];
  lines: Prisma.EntryLineCreateManyInput[];
};

export const entryIdFor = (key: string): string => seedId(`entry:${key}`);

/**
 * Drafts entries in memory so they can be written in one transaction, and
 * refuses an unbalanced one here rather than letting it surface as a deferred
 * trigger failure at COMMIT — by then the message names a uuid and not the
 * line of seed code that got the signs wrong.
 */
export const createLedger = (ownerId: string): Ledger => {
  const entries: Prisma.EntryCreateManyInput[] = [];
  const lines: Prisma.EntryLineCreateManyInput[] = [];

  const post = (draft: EntryDraft): string => {
    const total = draft.lines.reduce((sum, line) => sum + line.amountMinor, 0n);
    if (total !== 0n) {
      throw new Error(`seed entry "${draft.key}" is out of balance by ${total}`);
    }
    if (draft.lines.length < 2) {
      throw new Error(`seed entry "${draft.key}" has fewer than two lines`);
    }

    const id = entryIdFor(draft.key);
    entries.push({
      id,
      ownerId,
      occurredOn: draft.occurredOn,
      payee: draft.payee ?? null,
      memo: draft.memo ?? null,
      recordedAt: atHour(draft.occurredOn, 12),
      reversesEntryId: draft.reversesKey ? entryIdFor(draft.reversesKey) : null,
      replacesEntryId: draft.replacesKey ? entryIdFor(draft.replacesKey) : null,
    });

    draft.lines.forEach((line, index) => {
      lines.push({
        id: seedId(`line:${draft.key}:${index}`),
        entryId: id,
        ledgerAccountId: line.ledgerAccountId,
        amountMinor: line.amountMinor,
        projectId: line.projectId ?? null,
        excludedFromReporting: line.excludedFromReporting ?? false,
      });
    });

    return id;
  };

  return { post, entries, lines };
};
