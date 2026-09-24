import { Modal } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { formatMinorUnits } from '../../lib/money.js';
import { useEntry } from './api.js';

type Props = {
  entryId: string;
  accountId: string;
  onClose: () => void;
};

const asDate = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });

/**
 * Read-only in this phase. Lines render exactly as returned, signs included,
 * and there is no total row: the account line already states the total, and
 * summing here would be money arithmetic in the browser.
 */
export const SplitDetailDrawer = ({ entryId, accountId, onClose }: Props) => {
  const { data: entry, isPending, isError } = useEntry(entryId);

  const paidFrom = entry?.lines.filter((line) => line.ledgerAccountId === accountId) ?? [];
  const splitAcross = entry?.lines.filter((line) => line.ledgerAccountId !== accountId) ?? [];

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      side="right"
      title={entry?.payee ?? 'Split detail'}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {isPending && <p className="text-sm text-slate-500">Loading…</p>}
      {isError && <p className="text-sm text-rose-700">This entry didn’t load.</p>}

      {entry && (
        <>
          <p className="mb-4 text-sm text-slate-500">{asDate(entry.occurredOn)}</p>

          <Section title="Paid from" lines={paidFrom} />
          <Section title="Split across" lines={splitAcross} />
        </>
      )}
    </Modal>
  );
};

const Section = ({
  title,
  lines,
}: {
  title: string;
  lines: { id: string; ledgerAccountName: string; amountMinor: bigint; excludedFromReporting: boolean }[];
}) => (
  <section className="mb-5">
    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {title}
    </h3>
    <table className="w-full">
      <tbody>
        {lines.map((line) => (
          <tr key={line.id} className="border-b border-slate-100 last:border-0">
            <td className="py-1.5 text-sm text-slate-700">
              {line.ledgerAccountName}
              {line.excludedFromReporting && (
                <span className="ml-2 text-xs text-slate-400">(excluded)</span>
              )}
            </td>
            <td className="py-1.5 text-right text-sm tabular-nums text-slate-800">
              {formatMinorUnits(line.amountMinor, { signDisplay: 'always' })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </section>
);
