import type { Prisma } from '@prisma/client';
import { seedId } from './ids.js';
import { addDays, addMonths, dayOfMonth, startOfMonth } from './time.js';

/**
 * Scheduled bills and income. **No occurrences are seeded** — they expand
 * lazily from these rules up to a horizon, so writing them here would either
 * duplicate what expansion produces or contradict it. `materializedThrough`
 * is left null for the same reason: nothing has been expanded yet.
 *
 * Every amount is fixed rather than drawn from the seeded rng, so adding this
 * file moved no figure in six months of existing history: the rng sequence is
 * shared, and one extra draw would have shifted every value after it.
 *
 * `amountMinor` is the signed amount posted to the account side, so a bill is
 * negative and income positive — including a charge on the credit card, where
 * "more is owed" is also negative. That is the net-worth basis the projection
 * reports in, and it is why nothing in this phase flips a sign.
 */
type SeriesSpec = {
  key: string;
  payee: string;
  amountMinor: bigint;
  account: string;
  category: string;
  frequency: Prisma.RecurringSeriesCreateManyInput['frequency'];
  dayOfMonth?: number;
  firstDueOn: Date;
};

const build = (
  ownerId: string,
  specs: readonly SeriesSpec[],
): Prisma.RecurringSeriesCreateManyInput[] =>
  specs.map((spec) => ({
    id: seedId(`series:${ownerId}:${spec.key}`),
    ownerId,
    payee: spec.payee,
    amountMinor: spec.amountMinor,
    ledgerAccountId: spec.account,
    categoryId: spec.category,
    frequency: spec.frequency,
    dayOfMonth: spec.dayOfMonth ?? null,
    firstDueOn: spec.firstDueOn,
    endsOn: null,
    materializedThrough: null,
  }));

/**
 * Every recurring bill starts *after* today, because six months of history
 * already contains the rent and the power bill that were actually paid: a
 * series anchored in the past would expand into occurrences competing with the
 * entries that settled them, and the forecast would read as a pile of unpaid
 * bills that are not unpaid at all.
 *
 * The one exception is deliberate — a single one-off bill dated three days ago,
 * which nothing in history pays. It is the overdue case the projection must
 * exclude from its figure and still show, and a one-off is the honest shape for
 * it: there is no recurring water bill in the ledger for it to contradict.
 *
 * Salary is biweekly, matching the approved mock-up, so a one-month horizon
 * contains two paydays and the forecast visibly slopes upward. History pays it
 * monthly; the series describes what happens from here, not what happened.
 */
export const buildDemoRecurring = (
  ownerId: string,
  anchor: Date,
  accountId: (key: string) => string,
): Prisma.RecurringSeriesCreateManyInput[] => {
  const nextMonth = startOfMonth(addMonths(anchor, 1));
  const checking = accountId('checking');
  const visa = accountId('visa');

  return build(ownerId, [
    {
      key: 'salary',
      payee: 'Acme Corp Payroll',
      amountMinor: 242_990n,
      account: checking,
      category: accountId('salary'),
      frequency: 'biweekly',
      firstDueOn: addDays(anchor, 3),
    },
    {
      key: 'rent',
      payee: 'Harbor Apartments',
      amountMinor: -165_000n,
      account: checking,
      category: accountId('rent'),
      frequency: 'monthly',
      dayOfMonth: 1,
      firstDueOn: dayOfMonth(nextMonth, 1),
    },
    {
      key: 'utilities',
      payee: 'City Power & Light',
      amountMinor: -11_840n,
      account: checking,
      category: accountId('utilities'),
      frequency: 'monthly',
      dayOfMonth: 3,
      firstDueOn: dayOfMonth(nextMonth, 3),
    },
    {
      key: 'fitness',
      payee: 'Ironworks Gym',
      amountMinor: -3_500n,
      account: visa,
      category: accountId('fitness'),
      frequency: 'monthly',
      dayOfMonth: 5,
      firstDueOn: dayOfMonth(nextMonth, 5),
    },
    {
      key: 'water-overdue',
      payee: 'Riverside Water',
      amountMinor: -6_420n,
      account: checking,
      category: accountId('utilities'),
      frequency: 'oneOff',
      firstDueOn: addDays(anchor, -3),
    },
  ]);
};

/** One series for B, so the projection has something to leak if it is going to. */
export const buildDecoyRecurring = (
  ownerId: string,
  anchor: Date,
  accountId: (key: string) => string,
): Prisma.RecurringSeriesCreateManyInput[] =>
  build(ownerId, [
    {
      key: 'dock-fees',
      payee: 'REEF Dock Fees',
      amountMinor: -99_999n,
      account: accountId('checking'),
      category: accountId('spending'),
      frequency: 'monthly',
      dayOfMonth: 8,
      firstDueOn: dayOfMonth(startOfMonth(addMonths(anchor, 1)), 8),
    },
  ]);
