import { useState } from 'react';
import { useNavigate } from 'react-router';
import { NavRail } from '../../components/NavRail.jsx';
import { Button } from '../../components/ui/button.js';
import { problemOf } from '../../lib/api.js';
import { formatMinorUnits } from '../../lib/money.js';
import { AccountsSidebar } from '../accounts/AccountsSidebar.js';
import { formatMonthLong } from '../reporting/params.js';
import { ConsentDialog } from './ConsentDialog.jsx';
import { GroupsTable } from './GroupsTable.jsx';
import { SentPayloadDialog } from './SentPayloadDialog.jsx';
import { SparkIcon } from './icons.jsx';
import { useInsightsSettings, useSetConsent, useSpendingReport } from './api.js';
import { recentMonths, useInsightsParams } from './params.js';

const MATCHING_RULE =
  'Groups match payees by name after case, spacing and punctuation are ignored, so AMAZON MKTP and Amazon Mktp*2A1 count as one.';

export const InsightsPage = () => {
  const navigate = useNavigate();
  const params = useInsightsParams();
  const settings = useInsightsSettings();
  const consent = useSetConsent();

  const [generated, setGenerated] = useState(false);
  const [askingConsent, setAskingConsent] = useState(false);
  const [showingPayload, setShowingPayload] = useState(false);

  const report = useSpendingReport(params.from, params.to, params.grouping, generated);

  const semanticAvailable = settings.data?.semanticAvailable ?? false;
  const consented = settings.data?.enabled ?? false;
  const wantsMeaning = params.grouping === 'meaning';

  // Until the server has answered, the switch is not yet operable and does not
  // yet claim anything: "unavailable" is a statement about this deployment, and
  // saying it while the answer is in flight would be a guess the user reads as
  // a fact.
  const switchLabel = settings.isSuccess
    ? semanticAvailable
      ? wantsMeaning
        ? ' — merchant names only'
        : ' — uses AI, off by default'
      : ' — unavailable'
    : '';

  // The model was asked for and did not answer usefully. A withheld key says so
  // on the switch instead, and a period with nothing in it is not a failure.
  const degraded =
    report.data?.grouping === 'name' &&
    (report.data.fallback === 'provider-failed' || report.data.fallback === 'unreconciled');

  const toggleMeaning = () => {
    if (wantsMeaning) {
      params.setGrouping('name');
      return;
    }
    if (!consented) {
      setAskingConsent(true);
      return;
    }
    params.setGrouping('meaning');
  };

  const acceptConsent = () =>
    consent.mutate(true, {
      onSuccess: () => {
        setAskingConsent(false);
        params.setGrouping('meaning');
      },
    });

  return (
    <div className="flex min-h-screen bg-slate-50">
      <NavRail />
      <AccountsSidebar
        selectedId={null}
        onSelect={(account) => void navigate(`/transactions?account=${account.id}`)}
      />

      <main className="min-w-0 flex-1 px-6 py-5">
        <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Spending insights</h1>
            <p className="text-sm text-slate-500">All accounts, expenses only</p>
          </div>
          <select
            aria-label="Period"
            value={params.period}
            onChange={(event) => params.setPeriod(event.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
          >
            {recentMonths(new Date()).map((month) => (
              <option key={month} value={month}>
                {formatMonthLong(month)}
              </option>
            ))}
          </select>
        </header>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            onClick={() => (generated ? void report.refetch() : setGenerated(true))}
            disabled={report.isFetching}
          >
            <SparkIcon />
            {report.isFetching ? 'Generating…' : 'Generate report'}
          </Button>

          <button
            type="button"
            role="switch"
            aria-checked={wantsMeaning}
            aria-label="Group by meaning"
            disabled={!settings.isSuccess || !semanticAvailable}
            onClick={toggleMeaning}
            className="inline-flex items-center gap-2.5 text-sm font-semibold disabled:opacity-55"
          >
            {/*
              The knob is a flex child inside the track's own padding, not an
              absolutely positioned box: 40px track − 2×3px padding − 14px knob
              leaves exactly 20px of travel, so `translate-x-5` lands it flush
              against the inside of the right edge and it cannot escape the
              track or cover the label beside it.
            */}
            <span
              className={`inline-flex h-5 w-10 flex-none items-center rounded-full p-[3px] transition-colors motion-reduce:transition-none ${
                wantsMeaning ? 'bg-emerald-700' : 'bg-slate-300'
              }`}
            >
              <span
                className={`size-3.5 flex-none rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${
                  wantsMeaning ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </span>
            <span>
              Group by meaning
              <span className="font-normal text-slate-500">{switchLabel}</span>
            </span>
          </button>
        </div>

        {!semanticAvailable && settings.isSuccess && (
          <p className="mb-4 text-xs text-slate-500">
            Grouping by meaning needs an API key, which this server does not have. The report
            below is unaffected.
          </p>
        )}

        {report.isFetching && (
          <div aria-busy="true" className="space-y-3">
            {[0, 1, 2, 3].map((n) => (
              <div
                key={n}
                className="grid grid-cols-[1fr_26%_9rem] gap-3.5 border-b border-slate-100 py-4"
              >
                <div className="h-3 w-3/5 rounded bg-slate-100 motion-safe:animate-pulse" />
                <div className="h-3 rounded bg-slate-100 motion-safe:animate-pulse" />
                <div className="h-3 rounded bg-slate-100 motion-safe:animate-pulse" />
              </div>
            ))}
            <span className="sr-only">Generating the report</span>
          </div>
        )}

        {report.isError && (
          <div className="flex min-h-52 flex-col items-start justify-center gap-2.5">
            <h2 className="text-base font-semibold text-slate-900">The report didn’t load</h2>
            <p role="alert" className="w-full rounded bg-rose-50 px-2.5 py-2 text-sm text-rose-800">
              {problemOf(report.error)?.detail ?? 'Something went wrong.'}
            </p>
            <Button onClick={() => void report.refetch()}>Try again</Button>
          </div>
        )}

        {report.isSuccess && !report.isFetching && (
          <>
            {degraded && (
              <p
                role="status"
                className="mb-3 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
              >
                <SparkIcon />
                Grouping by meaning didn’t work this time, so these groups are matched by name.
                Nothing was lost, and the totals are the same.
              </p>
            )}

            {report.data.groups.length === 0 ? (
              <div className="py-10">
                <h2 className="text-base font-semibold text-slate-900">
                  No spending in this period
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  There is nothing to group. Pick another period, or check whether these
                  transactions are excluded from reports.
                </p>
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-end justify-between gap-3">
                  <p className="text-xs font-semibold text-slate-500">Total spent, grouped</p>
                  {/* The API's total, never a sum of the rows below. */}
                  <p className="text-2xl font-semibold tabular-nums text-slate-900">
                    {formatMinorUnits(report.data.totalMinor)}
                  </p>
                </div>

                <GroupsTable report={report.data} />

                {report.data.grouping === 'meaning' ? (
                  <p className="mt-3 flex items-start gap-2 text-xs text-slate-500">
                    <SparkIcon size={14} />
                    <span>
                      <b className="font-semibold text-slate-700">What was sent:</b> the{' '}
                      {report.data.sent.names.length} merchant names in this period, and nothing
                      else. No amounts, dates, accounts or balances left the server. Amounts above
                      were summed here.{' '}
                      <button
                        type="button"
                        onClick={() => setShowingPayload(true)}
                        className="underline"
                      >
                        See exactly what was sent
                      </button>
                    </span>
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-slate-500">{MATCHING_RULE}</p>
                )}
              </>
            )}
          </>
        )}

        <ConsentDialog
          open={askingConsent}
          onOpenChange={setAskingConsent}
          onAccept={acceptConsent}
          pending={consent.isPending}
        />

        {report.data?.grouping === 'meaning' && (
          <SentPayloadDialog
            open={showingPayload}
            onOpenChange={setShowingPayload}
            period={params.period}
            sent={report.data.sent}
          />
        )}
      </main>
    </div>
  );
};
