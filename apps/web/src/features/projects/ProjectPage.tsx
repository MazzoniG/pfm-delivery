import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ProjectInUseProblem, type ProjectLine, type ProjectReport } from '@pfm/contracts';
import { NavRail } from '../../components/NavRail.jsx';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/dialog.js';
import { problemOf } from '../../lib/api.js';
import { formatMinorUnits } from '../../lib/money.js';
import { AccountsSidebar } from '../accounts/AccountsSidebar.js';
import { localIsoDate } from '../accounts/asOf.js';
import { CategoryTable, accountLabel } from '../reporting/CategoryTable.jsx';
import { MonthlySpendingChart, MonthlySpendingChartSkeleton } from '../reporting/MonthlySpendingChart.jsx';
import {
  formatDayShort,
  formatMonthShort,
  monthEnd,
  monthsBetween,
  rangeDates,
} from '../reporting/params.js';
import { CorrectionBadges } from '../transactions/CorrectionBadges.jsx';
import { SplitEditor } from '../transactions/SplitEditor.jsx';
import { SplitIcon } from '../transactions/icons.jsx';
import { ProjectNameDialog } from './ProjectNameDialog.jsx';
import { useDeleteProject, useProjectReport, useRenameProject } from './api.js';
import { formatMonthSpan, projectActivity } from './format.js';

/** The register is account-scoped; open it on the account of the latest line. */
const registerHref = (projectId: string, lines: ProjectLine[]): string => {
  const account = lines[0]?.accounts[0]?.ledgerAccountId;
  return `/transactions?${account ? `account=${account}&` : ''}project=${projectId}`;
};

export const ProjectPage = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const now = new Date();
  // Six whole months ending with this one; the project page has no range control.
  const { from, to } = rangeDates('6m', now);
  const report = useProjectReport(id, from, to);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <NavRail />
      <AccountsSidebar
        selectedId={null}
        onSelect={(account) => void navigate(`/transactions?account=${account.id}`)}
      />

      <main className="min-w-0 flex-1 px-6 py-5">
        <Link to="/projects" className="mb-2.5 inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M7.5 3 4.5 6l3 3" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          All projects
        </Link>

        {report.isPending && (
          <>
            <div aria-busy="true" className="mb-5 h-6 w-48 rounded bg-slate-100 motion-safe:animate-pulse" />
            <MonthlySpendingChartSkeleton
              title="Project spending per month"
              labels={monthsBetween(from, to).map(formatMonthShort)}
            />
            <span className="sr-only">Loading the project</span>
          </>
        )}

        {report.isError && (
          <div className="flex min-h-52 flex-col items-start justify-center gap-2.5">
            <h1 className="text-base font-semibold text-slate-900">The project didn’t load</h1>
            <p role="alert" className="w-full rounded bg-rose-50 px-2.5 py-2 text-sm text-rose-800">
              {problemOf(report.error)?.detail ?? 'Something went wrong.'}
            </p>
            <Button onClick={() => void report.refetch()}>Try again</Button>
          </div>
        )}

        {report.isSuccess && <ProjectDetail report={report.data} today={now} />}
      </main>
    </div>
  );
};

const ProjectDetail = ({ report, today }: { report: ProjectReport; today: Date }) => {
  const navigate = useNavigate();
  const { project } = report;
  const rename = useRenameProject(project.id);
  const remove = useDeleteProject(project.id);
  const [renaming, setRenaming] = useState(false);
  const [split, setSplit] = useState<{ entryId: string; accountId: string } | null>(null);

  const todayIso = localIsoDate(today);
  const currentMonth = todayIso.slice(0, 7);
  const partialMonth = todayIso < monthEnd(currentMonth) ? currentMonth : null;
  const inRegister = registerHref(project.id, report.lines);

  const deleteProject = async () => {
    try {
      await remove.mutateAsync();
      void navigate('/projects');
    } catch {}
  };

  const deleteProblem = problemOf(remove.error);
  const inUse = ProjectInUseProblem.safeParse(deleteProblem).success;

  return (
    <>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{project.name}</h1>
          <p className="text-sm text-slate-500">{projectActivity(project)}</p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="mr-2 text-right">
            <p className="text-xs font-semibold text-slate-500">Net cost</p>
            <p className="text-2xl font-semibold tabular-nums text-slate-900">
              {formatMinorUnits(project.netCostMinor)}
            </p>
          </div>
          <Button onClick={() => setRenaming(true)}>Rename</Button>
          <Button aria-label="Delete project" onClick={() => void deleteProject()} disabled={remove.isPending}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M2.5 4h9M5.5 4V2.5h3V4M4 4l.6 7.5h4.8L10 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </div>
      </header>

      <MonthlySpendingChart
        title="Project spending per month"
        months={report.months}
        partialMonth={partialMonth}
      />

      <h2 className="mb-2 text-xs font-semibold text-slate-600">By category</h2>
      {report.categories.length === 0 ? (
        <p className="mb-6 text-sm text-slate-500">No project spending in these six months.</p>
      ) : (
        <div className="mb-6">
          <CategoryTable
            periodLabel={`${project.name}, ${formatMonthSpan(report.from, report.to)}`}
            scope="period"
            categories={report.categories}
            period={{ from: report.from, to: report.to }}
          />
        </div>
      )}

      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold text-slate-600">Transactions</h2>
        <Link to={inRegister} className="text-sm font-semibold text-emerald-800 hover:underline">
          Show in register
        </Link>
      </div>

      {report.lines.length === 0 ? (
        <p className="text-sm text-slate-500">No transactions are assigned to this project yet.</p>
      ) : (
        <table className="w-full border-collapse">
          <caption className="sr-only">Transactions in {project.name}, every account</caption>
          <tbody>
            {report.lines.map((line) => (
              <LineRow
                key={line.lineId}
                line={line}
                onOpenSplit={(accountId) => setSplit({ entryId: line.entryId, accountId })}
              />
            ))}
          </tbody>
        </table>
      )}

      {report.linesTruncated && (
        <p className="mt-3 text-xs text-slate-500">
          Showing the latest {report.lines.length} transactions. The totals above cover all of them.
        </p>
      )}

      {renaming && (
        <ProjectNameDialog
          title="Rename project"
          submitLabel="Save name"
          initialName={project.name}
          pending={rename.isPending}
          error={rename.error}
          onSubmit={(name) => rename.mutateAsync(name)}
          onClose={() => {
            rename.reset();
            setRenaming(false);
          }}
        />
      )}

      {deleteProblem && (
        <Modal
          open
          onOpenChange={(next) => !next && remove.reset()}
          title={`${project.name} can’t be deleted`}
          footer={
            <>
              {inUse && <Button onClick={() => void navigate(inRegister)}>Show its transactions</Button>}
              <Button variant="primary" onClick={() => remove.reset()}>
                Close
              </Button>
            </>
          }
        >
          <p role="alert" className="mb-2.5 rounded bg-rose-50 px-2.5 py-2 text-sm text-rose-800">
            {deleteProblem.detail ?? deleteProblem.title}
          </p>
          {inUse && (
            <p className="text-sm text-slate-500">
              A project with no transactions can be deleted. One in use can be renamed.
            </p>
          )}
        </Modal>
      )}

      {split && (
        <SplitEditor entryId={split.entryId} accountId={split.accountId} onClose={() => setSplit(null)} />
      )}
    </>
  );
};

/**
 * Seen from the category side, like the report drill-down: spending positive,
 * a refund or a reversal negative. A split line shows its share over the
 * entry's total, both from the API.
 */
const LineRow = ({ line, onOpenSplit }: { line: ProjectLine; onOpenSplit: (accountId: string) => void }) => {
  const account = accountLabel(line);
  const payingAccount = line.accounts.length === 1 ? line.accounts[0] : undefined;

  return (
    <tr className="border-b border-slate-100 bg-white">
      <td className="px-2.5 py-2 text-sm">
        <span className="mr-3 tabular-nums text-slate-500">{formatDayShort(line.occurredOn)}</span>
        <span className="font-medium text-slate-800">{line.payee ?? '—'}</span>
        {account && <span className="ml-2.5 text-xs text-slate-500">{account}</span>}
        {line.entryTotalMinor !== null && payingAccount && (
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => onOpenSplit(payingAccount.ledgerAccountId)}
            className="ml-2.5 inline-flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-100"
          >
            <SplitIcon />
            Split
          </button>
        )}
        <CorrectionBadges reverses={line.reverses} reversedBy={line.reversedBy} replaces={line.replaces} />
      </td>
      <td className="w-40 px-2.5 py-2 text-right text-sm tabular-nums text-slate-800">
        {formatMinorUnits(line.amountMinor)}
        {line.entryTotalMinor !== null && (
          <span className="block text-xs text-slate-500">of {formatMinorUnits(line.entryTotalMinor)}</span>
        )}
      </td>
    </tr>
  );
};
