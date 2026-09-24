import type { RecurrenceFrequency } from '@prisma/client';
import {
  ACCOUNT_KINDS,
  CATEGORY_KINDS,
  MAX_BACKDATED_DAYS,
  MAX_PROJECTION_MONTHS,
  type CreateRecurringSeriesRequest,
  type LedgerAccountKind,
  type PayOccurrenceRequest,
  type RepeatRule,
} from '@pfm/contracts';
import {
  NotFoundError,
  OccurrencePaidError,
  UnprocessableError,
  ValidationError,
} from '../../shared/errors/app-error.js';
import type { EntryRow } from '../transactions/repository.js';
import type { EntryService } from '../transactions/service.js';
import type {
  OccurrenceRow,
  RecurringRepository,
  SeriesRow,
} from './repository.js';
import { toRepeatRule } from './mapper.js';
import { occurrenceDates } from './rules.js';

export type RecurringService = {
  createSeries(
    ownerId: string,
    input: CreateRecurringSeriesRequest,
  ): Promise<SeriesRow>;
  expandThrough(ownerId: string, horizon: Date): Promise<void>;
  pay(
    ownerId: string,
    occurrenceId: string,
    input: PayOccurrenceRequest,
  ): Promise<{ occurrence: OccurrenceRow; entry: EntryRow }>;
};

const DAY_MS = 86_400_000;

const toCalendarDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const calendarDate = (date: Date): string => date.toISOString().slice(0, 10);

const todayUtc = (): Date => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
};

const addMonths = (date: Date, months: number): Date =>
  new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      date.getUTCDate(),
    ),
  );

const isAccount = (kind: LedgerAccountKind): boolean =>
  (ACCOUNT_KINDS as readonly string[]).includes(kind);

const isCategory = (kind: LedgerAccountKind): boolean =>
  (CATEGORY_KINDS as readonly string[]).includes(kind);

/** The contract's kebab-case wire value against the Prisma enum member. */
const FREQUENCIES: Record<RepeatRule['frequency'], RecurrenceFrequency> = {
  'one-off': 'oneOff',
  weekly: 'weekly',
  biweekly: 'biweekly',
  monthly: 'monthly',
};

const earlier = (a: Date, b: Date): Date =>
  a.getTime() <= b.getTime() ? a : b;

export const createRecurringService = (
  recurring: RecurringRepository,
  entries: EntryService,
  now: () => Date = todayUtc,
): RecurringService => {
  /**
   * An FK proves the account exists, not that this caller may use it, and not
   * that it is the right side of the chart. Both sides are resolved in one
   * owner-scoped read and each is held to its own half of the kinds.
   */
  const resolveSides = async (
    ownerId: string,
    ledgerAccountId: string,
    categoryId: string,
  ): Promise<void> => {
    const owned = await recurring.ownedAccounts(ownerId, [
      ledgerAccountId,
      categoryId,
    ]);
    const kinds = new Map(owned.map((account) => [account.id, account.kind]));

    const account = kinds.get(ledgerAccountId);
    if (!account) {
      throw new UnprocessableError(
        'Unknown ledger account',
        `No account with id ${ledgerAccountId}.`,
      );
    }
    if (!isAccount(account)) {
      throw new UnprocessableError(
        'Not a real account',
        `A bill is paid from an asset or liability account, and ${ledgerAccountId} is ${account}.`,
      );
    }

    const category = kinds.get(categoryId);
    if (!category) {
      throw new UnprocessableError(
        'Unknown category',
        `No category with id ${categoryId}.`,
      );
    }
    if (!isCategory(category)) {
      throw new UnprocessableError(
        'Not a category',
        `A bill is booked to an income or expense category, and ${categoryId} is ${category}.`,
      );
    }
  };

  return {
    createSeries: async (ownerId, input) => {
      await resolveSides(ownerId, input.ledgerAccountId, input.categoryId);

      const firstDueOn = toCalendarDate(input.firstDueOn);
      const floor = new Date(now().getTime() - MAX_BACKDATED_DAYS * DAY_MS);
      if (firstDueOn.getTime() < floor.getTime()) {
        // 422 rather than 400: the date is well formed and a perfectly good
        // calendar date. What it violates is a rule about schedules, which is
        // the same class as naming an account of the wrong kind above.
        throw new UnprocessableError(
          'First due date is too far in the past',
          `A schedule may start at most ${MAX_BACKDATED_DAYS} days ago — on or after ${calendarDate(floor)} — and ${input.firstDueOn} is earlier than that. Record it as a transaction instead.`,
        );
      }

      return recurring.createSeries(ownerId, {
        payee: input.payee,
        amountMinor: input.amountMinor,
        ledgerAccountId: input.ledgerAccountId,
        categoryId: input.categoryId,
        frequency: FREQUENCIES[input.rule.frequency],
        dayOfMonth:
          input.rule.frequency === 'monthly' ? input.rule.dayOfMonth : null,
        firstDueOn,
        endsOn: input.endsOn === null ? null : toCalendarDate(input.endsOn),
      });
    },

    /**
     * Lazy expansion. Occurrences are written up to `horizon` and no further,
     * and the watermark records how far each series has been taken — so asking
     * for the same horizon again reads one row per series and writes nothing,
     * and asking for a nearer one writes nothing at all.
     */
    expandThrough: async (ownerId, horizon) => {
      const ceiling = addMonths(now(), MAX_PROJECTION_MONTHS);
      if (horizon.getTime() > ceiling.getTime()) {
        // The furthest allowed date, not only the rule: a caller that guesses
        // its way to a valid horizon has been told the limit badly.
        throw new ValidationError('Request validation failed', [
          {
            path: 'to',
            message: `must be within ${MAX_PROJECTION_MONTHS} months of today — on or before ${calendarDate(ceiling)}`,
          },
        ]);
      }

      const series = await recurring.seriesToExpand(ownerId, horizon);
      if (series.length === 0) return;

      const rows = series.flatMap((s) => {
        // The watermark is inclusive: everything up to it already exists, so
        // the next unwritten date is the day after.
        const from = s.materializedThrough
          ? new Date(s.materializedThrough.getTime() + DAY_MS)
          : s.firstDueOn;
        const to = s.endsOn ? earlier(s.endsOn, horizon) : horizon;

        return occurrenceDates(toRepeatRule(s), s.firstDueOn, from, to).map(
          (dueOn) => ({
            seriesId: s.id,
            dueOn,
            amountMinor: s.amountMinor,
          }),
        );
      });

      await recurring.addOccurrences(rows);
      // Every series that was considered, not only those that produced rows: a
      // series whose next bill is months away is finished with this horizon too.
      await recurring.advanceWatermark(
        ownerId,
        series.map((s) => s.id),
        horizon,
      );
    },

    /**
     * The entry is posted through the ordinary entry path — same validation,
     * same zero-sum trigger, same audit log — and only then linked. Nothing
     * here is a second way to write a transaction.
     */
    pay: async (ownerId, occurrenceId, input) => {
      const occurrence = await recurring.findOccurrence(ownerId, occurrenceId);
      if (!occurrence) {
        throw new NotFoundError(
          'Scheduled bill not found',
          `No scheduled bill with id ${occurrenceId}.`,
        );
      }
      if (occurrence.materializedEntryId) {
        throw new OccurrencePaidError(occurrence.materializedEntryId);
      }

      await resolveSides(
        ownerId,
        input.ledgerAccountId,
        occurrence.series.categoryId,
      );

      const entry = await entries.create(ownerId, {
        occurredOn: input.paidOn,
        description: null,
        payee: occurrence.series.payee,
        memo: null,
        accountId: input.ledgerAccountId,
        categoryId: occurrence.series.categoryId,
        amountMinor: input.amountMinor,
        projectId: null,
      });

      const linked = await recurring.linkEntry(ownerId, occurrenceId, entry.id);
      if (linked) return { occurrence: linked, entry };

      // Lost a race with another payment of the same bill. The entry we just
      // posted is ours, unlocked and seconds old, so withdrawing it is the
      // honest outcome — the alternative is a duplicate payment sitting in the
      // register with nothing pointing at it.
      await entries.remove(ownerId, entry.id);
      const paid = await recurring.findOccurrence(ownerId, occurrenceId);
      throw new OccurrencePaidError(paid?.materializedEntryId ?? entry.id);
    },
  };
};
