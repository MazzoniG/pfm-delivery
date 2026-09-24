import type { Prisma } from '@prisma/client';
import {
  DEMO_ACCOUNTS,
  DEMO_EXPENSES,
  DEMO_INCOME,
  SYSTEM_ACCOUNT,
  type ExpenseSpec,
} from './chart-of-accounts.js';
import { seedId } from './ids.js';
import { createLedger, type EntryDraft } from './ledger.js';
import { buildProjects } from './projects.js';
import { buildDemoRecurring } from './recurring.js';
import { createRng } from './rng.js';
import {
  addDays,
  addMonths,
  atHour,
  dayOfMonth,
  daysInMonth,
  startOfMonth,
} from './time.js';

export type Tenant = {
  ownerId: string;
  user: Prisma.UserCreateManyInput;
  accounts: Prisma.LedgerAccountCreateManyInput[];
  projects: Prisma.ProjectCreateManyInput[];
  entries: Prisma.EntryCreateManyInput[];
  lines: Prisma.EntryLineCreateManyInput[];
  /** Rules only. Occurrences expand lazily; see `seed/recurring.ts`. */
  recurring: Prisma.RecurringSeriesCreateManyInput[];
  /** Posted after the reconcile, because that is when they happened. */
  corrections: {
    entries: Prisma.EntryCreateManyInput[];
    lines: Prisma.EntryLineCreateManyInput[];
  };
  reconcile?: { from: Date; to: Date; at: Date };
};

const MONTHS_OF_HISTORY = 6;

/**
 * A card statement writes one merchant several ways — all caps on one line, a
 * terminal reference appended on another — which is the whole reason the
 * insights report normalises payees before grouping them. The seed does the
 * same, so that rule has something real to merge in the demo data.
 *
 * Derived from the day rather than the rng, so introducing it moved no other
 * seeded figure.
 */
const statementSpelling = (payee: string, day: number): string => {
  if (day % 7 === 0) return payee.toUpperCase();
  if (day % 5 === 0) return `${payee}*${1000 + ((day * 137) % 9000)}`;
  return payee;
};

export const buildDemoTenant = (ownerId: string, anchor: Date): Tenant => {
  const rng = createRng(0x5eed_1001);
  const accountId = (key: string): string => seedId(`account:${ownerId}:${key}`);

  const firstMonth = startOfMonth(addMonths(anchor, -(MONTHS_OF_HISTORY - 1)));
  const openedOn = dayOfMonth(firstMonth, 1);
  const reconciledMonth = startOfMonth(addMonths(anchor, -1));
  const reconciledAt = atHour(addDays(anchor, -2), 10);

  const accounts: Prisma.LedgerAccountCreateManyInput[] = [
    {
      id: accountId('opening-balances'),
      ownerId,
      name: SYSTEM_ACCOUNT.name,
      kind: SYSTEM_ACCOUNT.kind,
      isSystem: true,
      createdAt: atHour(openedOn, 9),
    },
    ...[...DEMO_ACCOUNTS, ...DEMO_INCOME, ...DEMO_EXPENSES].map((spec) => ({
      id: accountId(spec.key),
      ownerId,
      name: spec.name,
      kind: spec.kind,
      createdAt: atHour(openedOn, 9),
    })),
  ];

  const equity = accountId('opening-balances');
  const checking = accountId('checking');
  const savings = accountId('savings');
  const visa = accountId('visa');
  const drafts: EntryDraft[] = [];

  const spend = (
    key: string,
    on: Date,
    category: ExpenseSpec,
    payee: string,
    amountMinor: bigint,
    fundedBy: string,
  ): void => {
    drafts.push({
      key,
      occurredOn: on,
      payee,
      lines: [
        { ledgerAccountId: accountId(category.key), amountMinor },
        { ledgerAccountId: fundedBy, amountMinor: -amountMinor },
      ],
    });
  };

  // Opening balances. The card opens owing money, which is what makes the
  // liability sign real rather than theoretical.
  drafts.push({
    key: 'opening-checking',
    occurredOn: openedOn,
    payee: 'Balance Adjustment',
    lines: [
      { ledgerAccountId: checking, amountMinor: 512_450n },
      { ledgerAccountId: equity, amountMinor: -512_450n },
    ],
  });
  drafts.push({
    key: 'opening-savings',
    occurredOn: openedOn,
    payee: 'Balance Adjustment',
    lines: [
      { ledgerAccountId: savings, amountMinor: 1_208_000n },
      { ledgerAccountId: equity, amountMinor: -1_208_000n },
    ],
  });
  drafts.push({
    key: 'opening-visa',
    occurredOn: openedOn,
    payee: 'Balance Adjustment',
    lines: [
      { ledgerAccountId: visa, amountMinor: -45_200n },
      { ledgerAccountId: equity, amountMinor: 45_200n },
    ],
  });

  const everyday = DEMO_EXPENSES.filter((spec) => spec.everyday);
  const byKey = (key: string): ExpenseSpec => {
    const spec = DEMO_EXPENSES.find((candidate) => candidate.key === key);
    if (!spec) throw new Error(`unknown expense category "${key}"`);
    return spec;
  };

  for (let index = 0; index < MONTHS_OF_HISTORY; index += 1) {
    const month = startOfMonth(addMonths(firstMonth, index));
    const tag = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
    const on = (day: number): Date =>
      dayOfMonth(month, Math.min(day, daysInMonth(month)));
    const happened = (date: Date): boolean => date.getTime() <= anchor.getTime();

    const rent = byKey('rent');
    if (happened(on(1))) {
      spend(`${tag}-rent`, on(1), rent, 'Harbor Apartments', rng.minorUnits(rent.minCents, rent.maxCents), checking);
    }

    const utilities = byKey('utilities');
    if (happened(on(3))) {
      spend(`${tag}-utilities`, on(3), utilities, 'City Power & Light', rng.minorUnits(utilities.minCents, utilities.maxCents), checking);
    }

    const internet = byKey('internet');
    if (happened(on(5))) {
      spend(`${tag}-internet`, on(5), internet, 'Northlink Fibre', rng.minorUnits(internet.minCents, internet.maxCents), visa);
    }

    const fitness = byKey('fitness');
    if (happened(on(6))) {
      spend(`${tag}-fitness`, on(6), fitness, 'Ironworks Gym', rng.minorUnits(fitness.minCents, fitness.maxCents), visa);
    }

    const subscriptions = byKey('subscriptions');
    if (happened(on(7))) {
      spend(`${tag}-subscriptions`, on(7), subscriptions, rng.pick(subscriptions.payees), rng.minorUnits(subscriptions.minCents, subscriptions.maxCents), visa);
    }

    if (index % 3 === 0 && happened(on(8))) {
      const insurance = byKey('insurance');
      spend(`${tag}-insurance`, on(8), insurance, 'Meridian Insurance', rng.minorUnits(insurance.minCents, insurance.maxCents), checking);
    }

    if (rng.chance(25) && happened(on(9))) {
      const travel = byKey('travel');
      spend(`${tag}-travel`, on(9), travel, rng.pick(travel.payees), rng.minorUnits(travel.minCents, travel.maxCents), visa);
    }

    if (rng.chance(20) && happened(on(11))) {
      const education = byKey('education');
      spend(`${tag}-education`, on(11), education, 'Open Learning Co', rng.minorUnits(education.minCents, education.maxCents), checking);
    }

    if (happened(on(12))) {
      const pay = rng.minorUnits(238_000, 262_000);
      drafts.push({
        key: `${tag}-salary`,
        occurredOn: on(12),
        payee: 'Acme Corp Payroll',
        lines: [
          { ledgerAccountId: checking, amountMinor: pay },
          { ledgerAccountId: accountId('salary'), amountMinor: -pay },
        ],
      });
    }

    if (rng.chance(50) && happened(on(15))) {
      drafts.push({
        key: `${tag}-transfer`,
        occurredOn: on(15),
        payee: 'Transfer',
        lines: [
          { ledgerAccountId: savings, amountMinor: 50_000n },
          { ledgerAccountId: checking, amountMinor: -50_000n },
        ],
      });
    }

    // Paying the card touches no expense account — the charges were expensed
    // when they were made. This is the double-counting trap, closed by the model.
    if (happened(on(20))) {
      const payment = rng.minorUnits(22_000, 61_000);
      drafts.push({
        key: `${tag}-card-payment`,
        occurredOn: on(20),
        payee: 'Visa Credit Card Payment',
        lines: [
          { ledgerAccountId: visa, amountMinor: payment },
          { ledgerAccountId: checking, amountMinor: -payment },
        ],
      });
    }

    if (rng.chance(40) && happened(on(22))) {
      const fee = rng.minorUnits(45_000, 92_000);
      drafts.push({
        key: `${tag}-freelance`,
        occurredOn: on(22),
        payee: 'Brightside Studio',
        lines: [
          { ledgerAccountId: checking, amountMinor: fee },
          { ledgerAccountId: accountId('freelance'), amountMinor: -fee },
        ],
      });
    }

    if (happened(on(28))) {
      const interest = rng.minorUnits(280, 1_340);
      drafts.push({
        key: `${tag}-interest`,
        occurredOn: on(28),
        payee: 'High-Yield Savings',
        lines: [
          { ledgerAccountId: savings, amountMinor: interest },
          { ledgerAccountId: accountId('interest'), amountMinor: -interest },
        ],
      });
    }

    const everydayCount = rng.int(8, 12);
    for (let n = 0; n < everydayCount; n += 1) {
      const day = rng.int(1, daysInMonth(month));
      const category = rng.pick(everyday);
      const payee = rng.pick(category.payees);
      const amount = rng.minorUnits(category.minCents, category.maxCents);
      const fundedBy = rng.chance(60) ? visa : checking;
      const date = on(day);
      if (!happened(date)) continue;
      spend(
        `${tag}-spend-${n}`,
        date,
        category,
        statementSpelling(payee, day),
        amount,
        fundedBy,
      );
    }
  }

  const projects = buildProjects(ownerId, anchor, accountId, openedOn);
  drafts.push(...projects.drafts);

  // A real purchase split across two categories — one bank debit, two lines —
  // and across a project and none: only the Home Improvement line is the remodel.
  drafts.push({
    key: 'split-hardware',
    occurredOn: addDays(anchor, -3),
    payee: 'Maple Street Hardware',
    lines: [
      { ledgerAccountId: accountId('home-improvement'), amountMinor: 20_000n, projectId: projects.houseRemodelId },
      { ledgerAccountId: accountId('household'), amountMinor: 3_000n },
      { ledgerAccountId: checking, amountMinor: -23_000n },
    ],
  });

  drafts.push({
    key: 'split-market',
    occurredOn: addDays(anchor, -2),
    payee: 'Corner Market',
    lines: [
      { ledgerAccountId: accountId('groceries'), amountMinor: 6_010n },
      { ledgerAccountId: accountId('household'), amountMinor: 2_450n },
      { ledgerAccountId: visa, amountMinor: -8_460n },
    ],
  });

  // $100 lunch, $60 of it reimbursed: excluded from spending reports, still
  // part of the bank balance, which is why exclusion lives on the line.
  drafts.push({
    key: 'team-lunch',
    occurredOn: addDays(anchor, -10),
    payee: 'The Copper Kettle',
    memo: 'Team lunch — $60 reimbursed by the client',
    lines: [
      { ledgerAccountId: accountId('dining'), amountMinor: 4_000n },
      { ledgerAccountId: accountId('dining'), amountMinor: 6_000n, excludedFromReporting: true },
      { ledgerAccountId: checking, amountMinor: -10_000n },
    ],
  });

  // Miscategorised on purpose: this is the entry the correction fixes.
  drafts.push({
    key: 'cafe-original',
    occurredOn: dayOfMonth(reconciledMonth, 14),
    payee: 'Riverside Café',
    lines: [
      { ledgerAccountId: accountId('groceries'), amountMinor: 2_400n },
      { ledgerAccountId: checking, amountMinor: -2_400n },
    ],
  });

  const ledger = createLedger(ownerId);
  for (const draft of sortDrafts(drafts)) ledger.post(draft);

  // Dated today, not back into the filed period: the reconciled month stays
  // filed and the correction lands in the open one.
  const corrections = createLedger(ownerId);
  corrections.post({
    key: 'cafe-reversal',
    occurredOn: anchor,
    payee: 'Riverside Café',
    memo: 'Reverses the original — miscategorised as Groceries',
    reversesKey: 'cafe-original',
    lines: [
      { ledgerAccountId: accountId('groceries'), amountMinor: -2_400n },
      { ledgerAccountId: checking, amountMinor: 2_400n },
    ],
  });
  corrections.post({
    key: 'cafe-replacement',
    occurredOn: anchor,
    payee: 'Riverside Café',
    replacesKey: 'cafe-original',
    lines: [
      { ledgerAccountId: accountId('dining'), amountMinor: 2_400n },
      { ledgerAccountId: checking, amountMinor: -2_400n },
    ],
  });

  return {
    ownerId,
    user: { id: ownerId, displayName: 'Alex Rivera', createdAt: atHour(openedOn, 9) },
    accounts,
    projects: projects.projects,
    entries: ledger.entries,
    lines: ledger.lines,
    recurring: buildDemoRecurring(ownerId, anchor, accountId),
    corrections: { entries: corrections.entries, lines: corrections.lines },
    reconcile: {
      from: reconciledMonth,
      to: dayOfMonth(reconciledMonth, daysInMonth(reconciledMonth)),
      at: reconciledAt,
    },
  };
};

/** Chronological, then by key, so insert order — and every serial id — is stable. */
export const sortDrafts = (drafts: readonly EntryDraft[]): EntryDraft[] =>
  [...drafts].sort(
    (a, b) =>
      a.occurredOn.getTime() - b.occurredOn.getTime() ||
      a.key.localeCompare(b.key),
  );
