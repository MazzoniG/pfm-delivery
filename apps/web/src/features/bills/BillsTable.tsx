import type { ScheduledOccurrenceView } from '@pfm/contracts';
import { Button } from '../../components/ui/button.js';
import { formatMinorUnits, isMoneyIn } from '../../lib/money.js';
import { describeRule, formatDueOn } from './params.js';

type Props = {
  occurrences: ScheduledOccurrenceView[];
  overdue?: boolean;
  onPay: (occurrence: ScheduledOccurrenceView) => void;
  caption: string;
};

/**
 * One scheduled bill or paycheque per row. The amount carries the API's own
 * sign — a bill is negative and income positive, whichever account funds it —
 * and nothing here flips it: these are movements in the net-worth basis the
 * projected figure above is quoted in.
 */
export const BillsTable = ({ occurrences, overdue = false, onPay, caption }: Props) => (
  <table className="w-full border-collapse">
    <caption className="sr-only">{caption}</caption>
    <tbody>
      {occurrences.map((occurrence) => (
        <tr
          key={occurrence.id}
          className={`border-b border-slate-100 ${overdue ? 'bg-rose-50/60' : ''}`}
        >
          <td className="w-24 py-2.5 pr-2 align-middle text-[15px] tabular-nums text-slate-600">
            {formatDueOn(occurrence.dueOn)}
          </td>

          <td className="py-2.5 pr-2 align-middle">
            <span className="font-medium text-slate-900">{occurrence.payee}</span>
            <span className="ml-2 inline-block rounded-full bg-slate-100 px-2 py-px text-xs font-semibold text-slate-600">
              {describeRule(occurrence.rule)}
            </span>
            <div className="mt-0.5 text-[13px] text-slate-500">
              {occurrence.categoryName}, {occurrence.ledgerAccountName}
            </div>
          </td>

          <td
            className={`w-32 border-l-[3px] border-double border-rose-200 py-2.5 pl-3 text-right align-middle text-base tabular-nums ${
              isMoneyIn(occurrence.amountMinor) ? 'text-emerald-700' : 'text-slate-900'
            }`}
          >
            {formatMinorUnits(occurrence.amountMinor, { signDisplay: 'always' })}
          </td>

          <td className="w-28 py-2.5 pl-2 text-right align-middle">
            <Button onClick={() => onPay(occurrence)}>Mark paid</Button>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);
