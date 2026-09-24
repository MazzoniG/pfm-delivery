import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CalendarDate, type LedgerAccount, type ScheduledOccurrenceView } from '@pfm/contracts';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/dialog.js';
import { problemOf } from '../../lib/api.js';
import {
  formatMinorUnits,
  magnitudeMinorUnits,
  parseAmountToMinorUnits,
} from '../../lib/money.js';
import { formatAsOf } from '../accounts/asOf.js';
import { usePayOccurrence } from './api.js';

const FormSchema = z.object({
  paidOn: CalendarDate,
  amount: z
    .string()
    .min(1, 'Enter an amount')
    .refine((value) => parseAmountToMinorUnits(value) !== null, 'Use a format like 24.00')
    .refine((value) => parseAmountToMinorUnits(value) !== 0n, 'Enter an amount above zero'),
  ledgerAccountId: z.uuid('Choose an account'),
});

type FormValues = z.infer<typeof FormSchema>;

type Props = {
  occurrence: ScheduledOccurrenceView | null;
  accounts: LedgerAccount[];
  onOpenChange: (open: boolean) => void;
};

/**
 * Date and amount are prefilled from the schedule and both editable, because a
 * bill rarely arrives on exactly its scheduled date for exactly its scheduled
 * amount. The direction is not editable: a bill stays a bill, so the field
 * carries the magnitude and the occurrence's own sign is put back at submit.
 */
export const MarkPaidDialog = ({ occurrence, accounts, onOpenChange }: Props) => {
  const pay = usePayOccurrence(occurrence?.id ?? null);

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { paidOn: '', amount: '', ledgerAccountId: '' },
  });

  const { reset } = form;
  useEffect(() => {
    if (!occurrence) return;
    reset({
      paidOn: occurrence.dueOn,
      amount: formatMinorUnits(magnitudeMinorUnits(occurrence.amountMinor)),
      ledgerAccountId: occurrence.ledgerAccountId,
    });
    pay.reset();
    // `pay` is a fresh object each render; the occurrence is what this tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occurrence, reset]);

  const submit = form.handleSubmit(async (values) => {
    if (!occurrence) return;
    const magnitude = parseAmountToMinorUnits(values.amount);
    if (magnitude === null) return;

    const signed = occurrence.amountMinor < 0n ? -magnitude : magnitude;
    try {
      await pay.mutateAsync({
        paidOn: values.paidOn,
        amountMinor: signed.toString(),
        ledgerAccountId: values.ledgerAccountId,
      });
    } catch {
      return;
    }
    onOpenChange(false);
  });

  const problem = problemOf(pay.error);

  return (
    <Modal
      open={occurrence !== null}
      onOpenChange={onOpenChange}
      title="Mark paid"
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="mark-paid" variant="primary" disabled={pay.isPending}>
            {pay.isPending ? 'Creating…' : 'Create transaction'}
          </Button>
        </>
      }
    >
      {occurrence && (
        <>
          <div className="mb-3.5 flex items-center justify-between rounded-md bg-slate-50 px-3 py-2.5 text-sm">
            <span>
              <b className="font-semibold">{occurrence.payee}</b>{' '}
              <span className="text-slate-500">due {formatAsOf(occurrence.dueOn)}</span>
            </span>
            <span className="text-base tabular-nums">
              {formatMinorUnits(occurrence.amountMinor, { signDisplay: 'always' })}
            </span>
          </div>

          <form id="mark-paid" onSubmit={submit} className="grid grid-cols-2 gap-4">
            <Field label="Paid on" error={form.formState.errors.paidOn?.message}>
              <input type="date" {...form.register('paidOn')} className={inputClass} />
            </Field>

            <Field label="Amount" error={form.formState.errors.amount?.message}>
              <input inputMode="decimal" {...form.register('amount')} className={inputClass} />
            </Field>

            <Field
              label="From account"
              error={form.formState.errors.ledgerAccountId?.message}
              wide
            >
              <select {...form.register('ledgerAccountId')} className={inputClass}>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </Field>
          </form>

          <p className="mt-3 text-[13px] text-slate-500">
            This creates a transaction in your register and removes the bill from the projection.
          </p>

          {problem && (
            <p
              role="alert"
              className="mt-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
            >
              {problem.detail ?? problem.title}
            </p>
          )}
        </>
      )}
    </Modal>
  );
};

const inputClass =
  'w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-emerald-600 focus:outline-none';

const Field = ({
  label,
  error,
  wide,
  children,
}: {
  label: string;
  error?: string | undefined;
  wide?: boolean;
  children: React.ReactNode;
}) => (
  <label className={`block text-sm ${wide ? 'col-span-2' : ''}`}>
    <span className="mb-1 block font-medium text-slate-700">{label}</span>
    {children}
    {error && <span className="mt-1 block text-xs text-rose-700">{error}</span>}
  </label>
);
