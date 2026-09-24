import type { Db } from '../../shared/db/prisma.js';

export type InsightsRepository = {
  consentedAt(ownerId: string): Promise<Date | null>;
  setConsent(ownerId: string, at: Date | null): Promise<void>;
};

/**
 * Consent is the owner's own row, so "scoped by owner" here is the primary key
 * rather than a `WHERE` clause — and `update` on a missing id throws rather
 * than silently writing nobody's consent.
 */
export const createInsightsRepository = (db: Db): InsightsRepository => ({
  consentedAt: async (ownerId) => {
    const user = await db.user.findUnique({
      where: { id: ownerId },
      select: { semanticGroupingConsentedAt: true },
    });
    return user?.semanticGroupingConsentedAt ?? null;
  },

  setConsent: async (ownerId, at) => {
    await db.user.update({
      where: { id: ownerId },
      data: { semanticGroupingConsentedAt: at },
    });
  },
});
