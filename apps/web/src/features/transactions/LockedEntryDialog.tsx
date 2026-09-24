import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { Entry, LedgerAccount } from '@pfm/contracts';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/dialog.js';
import { formatMinorUnits, parseAmountToMinorUnits } from '../../lib/money.js';
import { problemOf } from '../../lib/api.js';
import { useCategories } from '../accounts/api.js';
import { usePostCorrection } from './api.js';
import { LockIcon } from './icons.jsx';

const FormSchema = z.object({
  categoryId: z.uuid('Choose a category'),
  amount: z
    .string()
    .min(1, 'Enter an amount')
    .refine((value) => parseAmountToMinorUnits(value) !== null, 'Use a format like 24.00'),
});

type FormValues = z.infer<typeof FormSchema>;

const asDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

type Props = {
  entry: Entry;
  account: LedgerAccount;
  lockedAt: string;
  onClose: () => void;
};

/**
 * Raised by the 409, not by a lock the client checked for itself: `lockedAt`
 * and the correction link come from the problem document the server sent.
 */
export const LockedEntryDialog = ({ entry, account, lockedAt, onClose }: Props) => {
  const correction = usePostCorrection(entry.id);

  const accountLine = entry.lines.find((line) => line.ledgerAccountId === account.id);
  const categoryLine = entry.lines.find((line) => line.ledgerAccountId !== account.id);

  // A correction restates an entry, so the picker offers the side the original
  // was on: recategorising salary must not be limited to expenses.
  const categories = useCategories(
    categoryLine?.ledgerAccountKind === 'income' ? 'income' : 'expense',
  );
  const magnitude = accountLine ? (accountLine.amountMinor < 0n ? -accountLine.amountMinor : accountLine.amountMinor) : 0n;
  const outward = (accountLine?.amountMinor ?? 0n) < 0n;

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      categoryId: categoryLine?.ledgerAccountId ?? '',
      amount: formatMinorUnits(magnitude),
    },
  });

  const submit = form.handleSubmit(async (values) => {
    const typed = parseAmountToMinorUnits(values.amount);
    if (typed === null || !accountLine) return;

    await correction.mutateAsync({
      payee: entry.payee,
      memo: entry.memo,
      accountId: account.id,
      categoryId: values.categoryId,
      // The direction of the original is kept; a correction restates an entry,
      // it does not turn a payment into a deposit.
      amountMinor: (outward ? -typed : typed).toString(),
    });
    onClose();
  });

  const problem = problemOf(correction.error);

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title="This transaction is reconciled"
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="post-correction" variant="primary" disabled={correction.isPending}>
            {correction.isPending ? 'Posting…' : 'Post correction'}
          </Button>
        </>
      }
    >
      <div className="mb-4 flex gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-inset ring-slate-200">
        <span className="mt-0.5 shrink-0">
          <LockIcon />
        </span>
        <span>
          {entry.payee ?? 'This entry'} on {asDate(`${entry.occurredOn}T00:00:00Z`)} was
          reconciled on {asDate(lockedAt)} and can’t be changed directly.
        </span>
      </div>

      <p className="mb-4 text-sm text-slate-600">
        Post a correction instead. The original stays as reconciled, and today gets two
        entries: one that reverses it and your corrected version.
      </p>

      <form id="post-correction" onSubmit={submit} className="grid grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Category</span>
          <select
            {...form.register('categoryId')}
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
          >
            <option value="">Choose…</option>
            {(categories.data ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          {form.formState.errors.categoryId && (
            <span className="mt-1 block text-xs text-rose-700">
              {form.formState.errors.categoryId.message}
            </span>
          )}
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Amount</span>
          <input
            inputMode="decimal"
            {...form.register('amount')}
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums"
          />
          {form.formState.errors.amount && (
            <span className="mt-1 block text-xs text-rose-700">
              {form.formState.errors.amount.message}
            </span>
          )}
        </label>
      </form>

      {problem && (
        <p role="alert" className="mt-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {problem.detail ?? problem.title}
        </p>
      )}
    </Modal>
  );
};
