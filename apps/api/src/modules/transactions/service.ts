import {
  CATEGORY_KINDS,
  apiPath,
  routes,
  type CorrectionReplacement,
  type CreateEntryRequest,
  type EntryListQuery,
  type LedgerAccountKind,
  type UpdateEntryRequest,
} from '@pfm/contracts';
import {
  EntryAlreadyCorrectedError,
  EntryLockedError,
  NotFoundError,
  UnprocessableError,
} from '../../shared/errors/app-error.js';
import type {
  EntryRepository,
  EntryRow,
  LineInput,
} from './repository.js';

export type EntryService = {
  page(ownerId: string, query: EntryListQuery): Promise<{
    rows: EntryRow[];
    nextCursor: string | null;
    projectEntriesInOtherAccounts?: number;
  }>;
  find(ownerId: string, id: string): Promise<EntryRow>;
  create(ownerId: string, input: CreateEntryRequest): Promise<EntryRow>;
  update(ownerId: string, id: string, patch: UpdateEntryRequest): Promise<EntryRow>;
  remove(ownerId: string, id: string): Promise<void>;
  correct(
    ownerId: string,
    id: string,
    replacement: CorrectionReplacement,
  ): Promise<{ original: EntryRow; reversal: EntryRow; replacement: EntryRow }>;
};

type DraftLine = {
  ledgerAccountId: string;
  amountMinor: bigint;
  projectId: string | null;
  excludedFromReporting: boolean;
};

const isCategory = (kind: LedgerAccountKind): boolean =>
  (CATEGORY_KINDS as readonly string[]).includes(kind);

/** The explicit form is the only write path; the simple form is sugar over it. */
const desugar = (
  input:
    | { lines: DraftLine[] }
    | { accountId: string; categoryId: string; amountMinor: bigint; projectId: string | null },
): DraftLine[] => {
  if ('lines' in input) return input.lines;
  return [
    {
      ledgerAccountId: input.accountId,
      amountMinor: input.amountMinor,
      projectId: null,
      excludedFromReporting: false,
    },
    {
      ledgerAccountId: input.categoryId,
      amountMinor: -input.amountMinor,
      projectId: input.projectId,
      excludedFromReporting: false,
    },
  ];
};

const toCalendarDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const todayUtc = (): Date => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
};

export const createEntryService = (
  entries: EntryRepository,
  now: () => Date = todayUtc,
): EntryService => {
  const missing = (id: string): NotFoundError =>
    new NotFoundError('Entry not found', `No entry with id ${id}.`);

  /**
   * An FK proves a row exists, not that this caller may use it. Without this,
   * an entry naming one of our accounts and one of someone else's would be
   * written happily — the one write path that defeats owner scoping entirely.
   */
  const resolveLines = async (
    ownerId: string,
    lines: readonly DraftLine[],
  ): Promise<LineInput[]> => {
    const accountIds = [...new Set(lines.map((line) => line.ledgerAccountId))];
    const owned = await entries.ownedAccounts(ownerId, accountIds);
    const kinds = new Map(owned.map((account) => [account.id, account.kind]));

    const unknown = accountIds.filter((id) => !kinds.has(id));
    if (unknown.length > 0) {
      throw new UnprocessableError(
        'Unknown ledger account',
        `No account with id ${unknown.join(', ')}.`,
      );
    }

    const projectIds = [
      ...new Set(lines.flatMap((line) => (line.projectId ? [line.projectId] : []))),
    ];
    if (projectIds.length > 0) {
      const ownedProjects = new Set(
        await entries.ownedProjectIds(ownerId, projectIds),
      );
      const unknownProject = projectIds.filter((id) => !ownedProjects.has(id));
      if (unknownProject.length > 0) {
        throw new UnprocessableError(
          'Unknown project',
          `No project with id ${unknownProject.join(', ')}.`,
        );
      }
    }

    for (const line of lines) {
      const kind = kinds.get(line.ledgerAccountId);
      if (kind && !isCategory(kind) && (line.projectId || line.excludedFromReporting)) {
        // "Which project is the −$230 from the bank attributable to" has no
        // answer; only the income and expense side of an entry can carry it.
        throw new UnprocessableError(
          'Dimension on a non-category line',
          `projectId and excludedFromReporting are only meaningful on income or expense lines, and ${line.ledgerAccountId} is ${kind}.`,
        );
      }
    }

    return lines.map((line) => ({ ...line }));
  };

  const load = async (ownerId: string, id: string): Promise<EntryRow> => {
    const entry = await entries.findById(ownerId, id);
    if (!entry) throw missing(id);
    return entry;
  };

  const loadEditable = async (ownerId: string, id: string): Promise<EntryRow> => {
    const entry = await entries.findById(ownerId, id);
    if (!entry) throw missing(id);
    if (entry.lockedAt) {
      throw new EntryLockedError(
        entry.lockedAt,
        apiPath(routes.entryCorrection(id)),
      );
    }
    return entry;
  };

  return {
    page: async (ownerId, query) => {
      const period = {
        ...(query.from ? { from: toCalendarDate(query.from) } : {}),
        ...(query.to ? { to: toCalendarDate(query.to) } : {}),
      };
      const [rows, elsewhere] = await Promise.all([
        entries.page(ownerId, {
          ledgerAccountId: query.accountId,
          limit: query.limit + 1,
          ...period,
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.q ? { payeeContains: query.q } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
        }),
        query.projectId
          ? entries.countProjectEntriesElsewhere(ownerId, {
              projectId: query.projectId,
              ledgerAccountId: query.accountId,
              ...period,
            })
          : undefined,
      ]);

      // One row past the page tells us another page exists without a count(*).
      const page = rows.slice(0, query.limit);
      const last = rows.length > query.limit ? page.at(-1) : undefined;

      return {
        rows: page,
        nextCursor: last
          ? `${last.occurredOn.toISOString().slice(0, 10)}:${last.id}`
          : null,
        ...(elsewhere !== undefined ? { projectEntriesInOtherAccounts: elsewhere } : {}),
      };
    },

    find: load,

    create: async (ownerId, input) => {
      const lines = await resolveLines(ownerId, desugar(input));
      return entries.create(ownerId, {
        occurredOn: toCalendarDate(input.occurredOn),
        description: input.description,
        payee: input.payee,
        memo: input.memo,
        lines,
      });
    },

    update: async (ownerId, id, patch) => {
      await loadEditable(ownerId, id);
      const lines = patch.lines
        ? await resolveLines(ownerId, patch.lines)
        : undefined;

      return entries.update(
        ownerId,
        id,
        {
          ...(patch.occurredOn ? { occurredOn: toCalendarDate(patch.occurredOn) } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.payee !== undefined ? { payee: patch.payee } : {}),
          ...(patch.memo !== undefined ? { memo: patch.memo } : {}),
        },
        lines,
      );
    },

    remove: async (ownerId, id) => {
      await loadEditable(ownerId, id);
      await entries.remove(ownerId, id);
    },

    correct: async (ownerId, id, replacement) => {
      const original = await load(ownerId, id);
      const alreadyReversed = (reversalId: string): EntryAlreadyCorrectedError =>
        new EntryAlreadyCorrectedError(id, reversalId, apiPath(routes.entry(reversalId)));

      const existing = original.reversedBy[0];
      if (existing) throw alreadyReversed(existing.id);
      const today = now();

      // The reversal copies `project_id` *and* `excluded_from_reporting`: one
      // that reported differently from the line it negates would leave the
      // project total and the category report overstated. These lines came out
      // of an owner-scoped read, so they need no second ownership check.
      const reversalLines: LineInput[] = original.lines.map((line) => ({
        ledgerAccountId: line.ledgerAccountId,
        amountMinor: -line.amountMinor,
        projectId: line.projectId,
        excludedFromReporting: line.excludedFromReporting,
      }));

      const written = await entries.correct(
        ownerId,
        {
          occurredOn: today,
          description: original.description,
          payee: original.payee,
          memo: `Reverses entry ${original.id}`,
          lines: reversalLines,
          reversesEntryId: original.id,
        },
        {
          occurredOn: today,
          description: replacement.description,
          payee: replacement.payee,
          memo: replacement.memo,
          lines: await resolveLines(ownerId, desugar(replacement)),
          replacesEntryId: original.id,
        },
      );

      if (written.kind === 'already-reversed') {
        const winner = (await load(ownerId, id)).reversedBy[0];
        if (!winner) throw new Error(`entry ${id} refused a reversal but has none`);
        throw alreadyReversed(winner.id);
      }

      // Re-read: the original is untouched, but it now has a reversal pointing
      // at it, and that is what `reversedByEntryId` reports.
      return {
        original: await load(ownerId, id),
        reversal: written.reversal,
        replacement: written.replacement,
      };
    },
  };
};
