import type {
  FallbackReason,
  InsightsSettings,
  SentPayloadWire,
  SpendingReportRequest,
} from '@pfm/contracts';
import type { Logger } from '../../shared/logging/logger.js';
import type { ReportingService } from '../reporting/service.js';
import type { PayeeGroupRow } from '../reporting/similar-groups.sql.js';
import { cacheKey, createReportCache, type ReportCache } from './cache.js';
import { applyGrouping, sumRows, type SemanticGroup } from './grouping.js';
import { ModelGroupings, type LlmProvider } from './port.js';
import type { InsightsRepository } from './repository.js';

export type SemanticReport = { groups: SemanticGroup[]; sent: SentPayloadWire };

export type SpendingReportResult =
  | { grouping: 'name'; rows: PayeeGroupRow[]; fallback: FallbackReason | null }
  | { grouping: 'meaning'; rows: PayeeGroupRow[]; semantic: SemanticReport };

export type InsightsService = {
  settings(ownerId: string): Promise<InsightsSettings>;
  setConsent(ownerId: string, enabled: boolean): Promise<InsightsSettings>;
  spendingReport(
    ownerId: string,
    request: SpendingReportRequest,
  ): Promise<SpendingReportResult>;
};

/**
 * The ranked merchants come from the reporting service rather than its query:
 * grouping and ranking is a reporting concern that this module reorganises, and
 * modules talk to each other through services.
 */
export const createInsightsService = (
  reporting: ReportingService,
  repository: InsightsRepository,
  provider: LlmProvider,
  log: Logger,
  cache: ReportCache<SemanticReport> = createReportCache<SemanticReport>(),
): InsightsService => {
  const degrade = (
    rows: PayeeGroupRow[],
    fallback: FallbackReason | null,
  ): SpendingReportResult => ({ grouping: 'name', rows, fallback });

  /**
   * Nothing leaves the process above this line. The consent read and the
   * availability check come before the query that produces the names, so the
   * order of this function is itself the guarantee: there is no path to
   * `provider.groupPayees` that skips them.
   */
  const semantic = async (
    ownerId: string,
    request: SpendingReportRequest,
    rows: PayeeGroupRow[],
  ): Promise<SpendingReportResult> => {
    const key = cacheKey(ownerId, request, rows);
    const hit = cache.get(key);

    let result: SemanticReport;
    if (hit !== null) {
      result = hit.value;
    } else {
      const names = rows.map((row) => row.payee);
      const at = new Date();
      try {
        // Parsed here as well as in the adapter: this is where an answer from
        // outside the process crosses into the report, and the port's type is a
        // promise the compiler cannot keep.
        const answer = ModelGroupings.parse(await provider.groupPayees(names));
        result = {
          groups: applyGrouping(rows, answer),
          sent: { names, at: at.toISOString() },
        };
      } catch (error) {
        log.info({ err: error }, 'semantic grouping refused, falling back to name matching');
        return degrade(rows, 'provider-failed');
      }
      // `at` is when the names were sent, which is what the payload viewer
      // shows. The cache's clock starts when the answer arrived, so a slow call
      // does not spend part of its own lifetime waiting.
      cache.set(key, result, new Date());
    }

    // Every return of a semantic report passes through here, cached or fresh.
    // The grouping puts every row in exactly one group, so this should not be
    // reachable — but showing figures that do not add up to the deterministic
    // total is worse than showing the plain report, and it is cheaper to check
    // than to reason about every path that could one day get here.
    const grouped = result.groups.reduce((total, group) => total + sumRows(group.payees), 0n);
    if (grouped !== sumRows(rows)) {
      log.info({ ownerId }, 'semantic groups did not reconcile, falling back');
      return degrade(rows, 'unreconciled');
    }

    return { grouping: 'meaning', rows, semantic: result };
  };

  return {
    settings: async (ownerId) => ({
      semanticAvailable: provider.available,
      enabled: (await repository.consentedAt(ownerId)) !== null,
    }),

    setConsent: async (ownerId, enabled) => {
      await repository.setConsent(ownerId, enabled ? new Date() : null);
      return {
        semanticAvailable: provider.available,
        enabled,
      };
    },

    spendingReport: async (ownerId, request) => {
      if (request.grouping === 'name') {
        return degrade(await reporting.similarGroups(ownerId, request), null);
      }

      if (!provider.available) {
        return degrade(await reporting.similarGroups(ownerId, request), 'no-key');
      }
      if ((await repository.consentedAt(ownerId)) === null) {
        return degrade(await reporting.similarGroups(ownerId, request), 'not-consented');
      }

      const rows = await reporting.similarGroups(ownerId, request);
      // An empty period has no names to send and nothing to group. The client
      // renders its empty state; there is no failure to explain.
      if (rows.length === 0) return degrade(rows, null);

      return semantic(ownerId, request, rows);
    },
  };
};
