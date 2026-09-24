import type { Prisma } from '@prisma/client';
import { seedId } from './ids.js';
import type { EntryDraft } from './ledger.js';
import { addMonths, atHour, dayOfMonth, startOfMonth } from './time.js';

export type ProjectSeed = {
  projects: Prisma.ProjectCreateManyInput[];
  /** Assigned to the demo's existing `split-hardware` entry, on its Home Improvement line only. */
  houseRemodelId: string;
  drafts: EntryDraft[];
};

/**
 * Two projects whose spending sits in different months, so the project chart
 * has a shape and the list's date spans differ. Fixed amounts, no RNG draws:
 * the demo's random sequence — and every seeded figure the tests derive from
 * it — is untouched by adding these.
 *
 * The cross-project case is not here but in the demo's `split-hardware` entry:
 * $200 of it to House remodel, the $30 Household line to no project. One entry,
 * two lines, one FK each — what a project on the entry could not express.
 */
export const buildProjects = (
  ownerId: string,
  anchor: Date,
  accountId: (key: string) => string,
  openedOn: Date,
): ProjectSeed => {
  const houseRemodelId = seedId(`project:${ownerId}:house-remodel`);
  const franceTripId = seedId(`project:${ownerId}:france-trip`);
  const month = (offset: number, day: number): Date =>
    dayOfMonth(startOfMonth(addMonths(anchor, offset)), day);

  const checking = accountId('checking');
  const visa = accountId('visa');

  const purchase = (
    key: string,
    occurredOn: Date,
    payee: string,
    category: string,
    amountMinor: bigint,
    fundedBy: string,
    projectId: string,
  ): EntryDraft => ({
    key,
    occurredOn,
    payee,
    lines: [
      { ledgerAccountId: accountId(category), amountMinor, projectId },
      { ledgerAccountId: fundedBy, amountMinor: -amountMinor },
    ],
  });

  return {
    projects: [
      { id: houseRemodelId, ownerId, name: 'House remodel', createdAt: atHour(openedOn, 9) },
      { id: franceTripId, ownerId, name: 'France trip', createdAt: atHour(openedOn, 9) },
    ],
    houseRemodelId,
    drafts: [
      purchase('remodel-hardware', month(-2, 28), 'Maple Street Hardware', 'household', 18_500n, visa, houseRemodelId),
      purchase('remodel-lumber', month(-1, 9), 'Oakline Lumber', 'home-improvement', 61_240n, visa, houseRemodelId),
      purchase('remodel-tile', month(-1, 24), 'Tile & Stone Co', 'home-improvement', 48_900n, checking, houseRemodelId),

      purchase('france-rail', month(-4, 18), 'Coastline Rail', 'travel', 21_400n, visa, franceTripId),
      purchase('france-hotel', month(-4, 19), 'Hotel Verde', 'travel', 96_000n, visa, franceTripId),
      purchase('france-bistro', month(-4, 21), 'Le Petit Bistro', 'dining', 7_850n, visa, franceTripId),
      purchase('france-museum', month(-3, 2), 'Musée Pass', 'entertainment', 6_200n, checking, franceTripId),
    ],
  };
};
