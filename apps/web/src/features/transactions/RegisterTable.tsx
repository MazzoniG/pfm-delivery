import { Fragment, useMemo } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { SPLIT_LABEL, type TransactionRowView } from '@pfm/contracts';
import { formatMinorUnits } from '../../lib/money.js';
import { EntryBadge as Badge } from './EntryBadge.jsx';
import { LockIcon, SplitIcon, TransferIcon } from './icons.jsx';

const monthOf = (date: string): string => date.slice(0, 7);

const monthLabel = (month: string): string =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const column = createColumnHelper<TransactionRowView>();

type Props = {
  rows: TransactionRowView[];
  onOpenSplit: (entryId: string) => void;
  onOpenEntry: (row: TransactionRowView) => void;
};

export const RegisterTable = ({ rows, onOpenSplit, onOpenEntry }: Props) => {
  const columns = useMemo(
    () => [
      column.accessor('occurredOn', {
        id: 'day',
        header: 'Day',
        // The month row above carries the month, so the cell shows the day only.
        cell: (cell) => cell.getValue().slice(-2),
      }),
      column.accessor('payee', {
        header: 'Payee',
        cell: (cell) => {
          const row = cell.row.original;
          return (
            <span className="flex flex-wrap items-center">
              <span className="font-medium text-slate-800">{cell.getValue() ?? '—'}</span>
              {/* The API's share, so a filtered split never reads as all project spending. */}
              {row.projectShareMinor !== undefined && row.counterparty.kind === 'split' && (
                <span className="ml-2 rounded-full bg-emerald-50 px-2 py-px text-xs font-semibold text-emerald-800">
                  {formatMinorUnits(row.projectShareMinor)} to this project
                </span>
              )}
              {row.replaces && <Badge tone="correction">Correction</Badge>}
              {row.reverses && (
                <Badge tone="reversal">{`Reversal of ${row.reverses.occurredOn}`}</Badge>
              )}
              {row.reversedBy && (
                <Badge tone="reversal">{`Reversed ${row.reversedBy.occurredOn}`}</Badge>
              )}
            </span>
          );
        },
      }),
      column.display({
        id: 'category',
        header: 'Category',
        cell: ({ row }) => {
          const { counterparty } = row.original;

          if (counterparty.kind === 'split') {
            return (
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenSplit(row.original.entryId);
                }}
                className="inline-flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-100"
              >
                <SplitIcon />
                {SPLIT_LABEL}
              </button>
            );
          }

          // A counter-side that is itself an account is a transfer; there is no
          // transfer type in the data, only two accounts on one entry.
          const isTransfer =
            counterparty.ledgerAccountKind === 'asset' ||
            counterparty.ledgerAccountKind === 'liability';

          return (
            <span className="inline-flex items-center gap-1.5 text-slate-700">
              {isTransfer && <TransferIcon />}
              {counterparty.name}
              {counterparty.excludedFromReporting && (
                <span className="text-xs text-slate-400">(excluded)</span>
              )}
            </span>
          );
        },
      }),
      column.display({
        id: 'status',
        header: () => <span className="sr-only">Status</span>,
        cell: ({ row }) => (row.original.lockedAt ? <LockIcon /> : null),
      }),
      column.accessor('amountMinor', {
        header: 'Amount, USD',
        cell: (cell) => {
          const amount = cell.getValue();
          return (
            <span
              className={`tabular-nums ${amount > 0n ? 'text-emerald-700' : 'text-slate-800'}`}
            >
              {formatMinorUnits(amount, { signDisplay: 'always' })}
            </span>
          );
        },
      }),
    ],
    [onOpenSplit],
  );

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  // Month headings are presentation only, grouped here from `occurredOn`
  // rather than asked of the API.
  let lastMonth = '';

  return (
    <table className="w-full border-collapse">
      <caption className="sr-only">Transactions in the selected account</caption>
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id} className="border-b border-slate-200">
            {group.headers.map((header) => (
              <th
                key={header.id}
                scope="col"
                className={`px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 ${
                  header.column.id === 'amountMinor' ? 'text-right' : 'text-left'
                }`}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => {
          const month = monthOf(row.original.occurredOn);
          const heading = month === lastMonth ? null : month;
          lastMonth = month;

          return (
            <Fragment key={row.id}>
              {heading && (
                <tr className="bg-slate-50">
                  <td
                    colSpan={columns.length}
                    className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600"
                  >
                    {monthLabel(heading)}
                  </td>
                </tr>
              )}
              <tr
                onClick={() => onOpenEntry(row.original)}
                className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 ${
                  row.original.lockedAt ? 'bg-slate-50/60' : ''
                }`}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={`px-3 py-2 align-top text-sm ${
                      cell.column.id === 'amountMinor' ? 'text-right' : ''
                    } ${cell.column.id === 'day' ? 'w-12 text-slate-500' : ''} ${
                      cell.column.id === 'status' ? 'w-8' : ''
                    }`}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
};
