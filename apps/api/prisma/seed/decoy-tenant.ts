import { SYSTEM_ACCOUNT } from './chart-of-accounts.js';
import { seedId } from './ids.js';
import { createLedger, type EntryDraft } from './ledger.js';
import { sortDrafts, type Tenant } from './demo-tenant.js';
import { buildDecoyRecurring } from './recurring.js';
import { addDays, atHour, startOfMonth, addMonths } from './time.js';

export const DECOY_USER_ID = seedId('user:decoy');

/**
 * The second tenant. It exists so the isolation test has something that *could*
 * leak, and every value in it is deliberately unmistakable — a leak has to show
 * up as a named row in an assertion, not as a count that is one too high. Every
 * name and payee carries "Reef", which nothing in the demo tenant does; the
 * isolation tests search responses for that marker.
 */
export const buildDecoyTenant = (anchor: Date): Tenant => {
  const ownerId = DECOY_USER_ID;
  const accountId = (key: string): string => seedId(`account:${ownerId}:${key}`);
  const openedOn = startOfMonth(addMonths(anchor, -2));

  const accounts = [
    { id: accountId('opening-balances'), ownerId, name: SYSTEM_ACCOUNT.name, kind: SYSTEM_ACCOUNT.kind, isSystem: true, createdAt: atHour(openedOn, 9) },
    { id: accountId('checking'), ownerId, name: 'Reef Savings', kind: 'asset' as const, createdAt: atHour(openedOn, 9) },
    { id: accountId('spending'), ownerId, name: 'Reef Supplies', kind: 'expense' as const, createdAt: atHour(openedOn, 9) },
    { id: accountId('income'), ownerId, name: 'Reef Frag Sales', kind: 'income' as const, createdAt: atHour(openedOn, 9) },
  ];

  const projectId = seedId(`project:${ownerId}:decoy`);
  const checking = accountId('checking');
  const spending = accountId('spending');

  const drafts: EntryDraft[] = [
    {
      key: 'decoy-opening',
      occurredOn: openedOn,
      payee: 'REEF Balance Adjustment',
      lines: [
        { ledgerAccountId: checking, amountMinor: 777_777n },
        { ledgerAccountId: accountId('opening-balances'), amountMinor: -777_777n },
      ],
    },
    {
      key: 'decoy-income',
      occurredOn: addDays(openedOn, 9),
      payee: 'REEF Frag Sales',
      lines: [
        { ledgerAccountId: checking, amountMinor: 333_333n },
        { ledgerAccountId: accountId('income'), amountMinor: -333_333n },
      ],
    },
    {
      key: 'decoy-spend-1',
      occurredOn: addDays(openedOn, 12),
      payee: 'REEF Aquatics',
      lines: [
        { ledgerAccountId: spending, amountMinor: 111_111n },
        { ledgerAccountId: checking, amountMinor: -111_111n },
      ],
    },
    {
      key: 'decoy-spend-2',
      occurredOn: addDays(openedOn, 26),
      payee: 'REEF Aquatics',
      lines: [
        { ledgerAccountId: spending, amountMinor: 222_222n, projectId },
        { ledgerAccountId: checking, amountMinor: -222_222n },
      ],
    },
    {
      key: 'decoy-spend-3',
      occurredOn: addDays(anchor, -5),
      payee: 'REEF Aquatics',
      lines: [
        { ledgerAccountId: spending, amountMinor: 444_444n, projectId },
        { ledgerAccountId: checking, amountMinor: -444_444n },
      ],
    },
  ];

  const ledger = createLedger(ownerId);
  for (const draft of sortDrafts(drafts)) ledger.post(draft);

  return {
    ownerId,
    user: {
      id: ownerId,
      displayName: 'Blake Okonkwo (isolation tenant)',
      createdAt: atHour(openedOn, 9),
    },
    accounts,
    projects: [
      { id: projectId, ownerId, name: 'Reef tank', createdAt: atHour(openedOn, 9) },
    ],
    entries: ledger.entries,
    lines: ledger.lines,
    recurring: buildDecoyRecurring(ownerId, anchor, accountId),
    corrections: { entries: [], lines: [] },
  };
};
