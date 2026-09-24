import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CalendarDate, LockedEntryProblem, type Entry, type LedgerAccount } from '@pfm/contracts';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/dialog.js';
import { formatMinorUnits, parseAmountToMinorUnits } from '../../lib/money.js';
import { problemOf } from '../../lib/api.js';
import { useCategories } from '../accounts/api.js';
import { useUpdateEntry } from './api.js';

const FormSchema = z.object({
  occurredOn: CalendarDate,
  payee: z.string().trim().max(120).optional(),
  categoryId: z.uuid('Choose a category'),
  amount: z
    .string()
    .min(1, 'Enter an amount')
    .refine((value) => parseAmountToMinorUnits(value) !== null, 'Use a format like 24.00')
    .refine((value) => parseAmountToMinorUnits(value) !== 0n, 'Enter an amount above zero'),
});

type FormValues = z.infer<typeof FormSchema>;

type Props = {
  entry: Entry;
  account: LedgerAccount;
  onClose: () => void;
  /** The server said 409. Everything the correction dialog needs is in there. */
  onLocked: (lockedAt: string) => void;
};

export const EditTransactionDialog = ({ entry, account, onClose, onLocked }: Props) => {
  const update = useUpdateEntry(entry.id);

  const accountLine = entry.lines.find((line) => line.ledgerAccountId === account.id);
  const counterLine = entry.lines.find((line) => line.ledgerAccountId !== account.id);
  const outward = (accountLine?.amountMinor ?? 0n) < 0n;
  const magnitude = outward ? -(accountLine?.amountMinor ?? 0n) : (accountLine?.amountMinor ?? 0n);

  const categories = useCategories(
    counterLine?.ledgerAccountKind === 'income' ? 'income' : 'expense',
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      occurredOn: entry.occurredOn,
      payee: entry.payee ?? '',
      categoryId: counterLine?.ledgerAccountId ?? '',
      amount: formatMinorUnits(magnitude),
    },
  });

  const submit = form.handleSubmit(async (values) => {
    const typed = parseAmountToMinorUnits(values.amount);
    if (typed === null || !accountLine) return;

    const signed = outward ? -typed : typed;

    try {
      await update.mutateAsync({
        occurredOn: values.occurredOn,
        payee: values.payee ?? null,
        lines: [
          { ledgerAccountId: account.id, amountMinor: signed.toString() },
          {
            ledgerAccountId: values.categoryId,
            amountMinor: (-signed).toString(),
            // Carried, not dropped: `lines` replaces the entry wholesale, and
            // these two default to null/false when absent — so omitting them
            // would quietly strip a project or an exclusion off an entry whose
            // category was edited.
            projectId: counterLine?.projectId ?? null,
            excludedFromReporting: counterLine?.excludedFromReporting ?? false,
          },
        ],
      });
      onClose();
    } catch (error) {
      const locked = LockedEntryProblem.safeParse(problemOf(error));
      if (locked.success) onLocked(locked.data.lockedAt);
    }
  });

  const problem = problemOf(update.error);
  const isLocked = LockedEntryProblem.safeParse(problem).success;

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title="Edit transaction"
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-transaction" variant="primary" disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="edit-transaction" onSubmit={submit} className="grid grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Date</span>
          <input type="date" {...form.register('occurredOn')} className={inputClass} />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Amount</span>
          <input inputMode="decimal" {...form.register('amount')} className={`${inputClass} tabular-nums`} />
          {form.formState.errors.amount && (
            <span className="mt-1 block text-xs text-rose-700">
              {form.formState.errors.amount.message}
            </span>
          )}
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Payee</span>
          <input {...form.register('payee')} className={inputClass} />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Category</span>
          <select {...form.register('categoryId')} className={inputClass}>
            <option value="">Choose…</option>
            {(categories.data ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
      </form>

      {problem && !isLocked && (
        <p role="alert" className="mt-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {problem.detail ?? problem.title}
        </p>
      )}
    </Modal>
  );
};

const inputClass =
  'w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-emerald-600 focus:outline-none';
