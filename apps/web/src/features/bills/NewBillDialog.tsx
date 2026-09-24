import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  CalendarDate,
  type CreateRecurringSeriesRequestWire,
  REPEAT_FREQUENCIES,
  type LedgerAccount,
  type RepeatRule,
} from '@pfm/contracts';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/dialog.js';
import { problemOf } from '../../lib/api.js';
import { parseAmountToMinorUnits } from '../../lib/money.js';
import { localIsoDate, parseIsoDate } from '../accounts/asOf.js';
import { useCategories } from '../accounts/api.js';
import { useCreateSeries } from './api.js';
import { WarningIcon } from './icons.jsx';
import { ordinal } from './params.js';

type Direction = 'bill' | 'income';

type Frequency = RepeatRule['frequency'];

const FormSchema = z.object({
  payee: z.string().trim().min(1, 'Enter a payee').max(120),
  amount: z
    .string()
    .min(1, 'Enter an amount')
    .refine((value) => parseAmountToMinorUnits(value) !== null, 'Use a format like 24.00')
    .refine((value) => parseAmountToMinorUnits(value) !== 0n, 'Enter an amount above zero'),
  firstDueOn: CalendarDate,
  ledgerAccountId: z.uuid('Choose an account'),
  categoryId: z.uuid('Choose a category'),
  frequency: z.enum(REPEAT_FREQUENCIES),
  endsOn: z.string(),
});

type FormValues = z.infer<typeof FormSchema>;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: LedgerAccount[];
  defaultAccountId: string;
};

const defaults = (accountId: string): FormValues => ({
  payee: '',
  amount: '',
  firstDueOn: localIsoDate(new Date()),
  ledgerAccountId: accountId,
  categoryId: '',
  frequency: 'monthly',
  endsOn: '',
});

/**
 * Two tabs, because the story says bills *and* income. The tab picks the half
 * of the chart the category comes from and decides the sign, exactly as the
 * add-transaction dialog does: the amount is typed as a positive decimal and
 * the signed minor-units string is built at submit.
 *
 * The monthly anchor day is taken from the first due date rather than asked for
 * twice — the contract requires the two to agree, and a second control is a
 * second way to contradict it.
 */
export const NewBillDialog = ({ open, onOpenChange, accounts, defaultAccountId }: Props) => {
  const [direction, setDirection] = useState<Direction>('bill');
  const create = useCreateSeries();
  const categories = useCategories(direction === 'income' ? 'income' : 'expense');

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: defaults(defaultAccountId),
  });

  const firstDueOn = form.watch('firstDueOn');
  const anchorDay = parseIsoDate(firstDueOn)?.getDate() ?? null;

  const label = (frequency: Frequency): string => {
    switch (frequency) {
      case 'one-off':
        return 'One-off';
      case 'weekly':
        return 'Weekly';
      case 'biweekly':
        return 'Every two weeks';
      case 'monthly':
        return anchorDay === null ? 'Monthly' : `Monthly on the ${ordinal(anchorDay)}`;
    }
  };

  const submit = form.handleSubmit(async (values) => {
    const magnitude = parseAmountToMinorUnits(values.amount);
    const day = parseIsoDate(values.firstDueOn)?.getDate();
    if (magnitude === null || day === undefined) return;

    // Account-side sign: a bill takes money out, income brings it in, whichever
    // account funds it — the basis the projected figure is quoted in.
    const signed = direction === 'income' ? magnitude : -magnitude;
    const rule: RepeatRule =
      values.frequency === 'monthly'
        ? { frequency: 'monthly', dayOfMonth: day }
        : { frequency: values.frequency };

    const body: CreateRecurringSeriesRequestWire = {
      payee: values.payee,
      amountMinor: signed.toString(),
      ledgerAccountId: values.ledgerAccountId,
      categoryId: values.categoryId,
      rule,
      firstDueOn: values.firstDueOn,
      endsOn: values.endsOn === '' ? null : values.endsOn,
    };

    try {
      await create.mutateAsync(body);
    } catch {
      return;
    }
    form.reset(defaults(values.ledgerAccountId));
    onOpenChange(false);
  });

  const problem = problemOf(create.error);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New bill or income"
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-bill" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Scheduling…' : 'Schedule it'}
          </Button>
        </>
      }
    >
      <Tabs.Root
        value={direction}
        onValueChange={(value) => {
          setDirection(value as Direction);
          // The category list changes with the tab, so the chosen one cannot
          // survive it: a bill booked to a salary account is not a thing.
          form.setValue('categoryId', '');
        }}
      >
        <Tabs.List className="mb-4 inline-flex rounded-md bg-slate-100 p-1">
          {(
            [
              ['bill', 'Bill'],
              ['income', 'Income'],
            ] as const
          ).map(([value, text]) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className="rounded px-3 py-1 text-sm data-[state=active]:bg-white data-[state=active]:font-semibold data-[state=active]:shadow-sm"
            >
              {text}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <form id="new-bill" onSubmit={submit} className="grid grid-cols-2 gap-4">
          <Field label="Payee" error={form.formState.errors.payee?.message} wide>
            <input
              placeholder={direction === 'income' ? 'Who pays you' : 'Who is paid'}
              {...form.register('payee')}
              className={inputClass}
            />
          </Field>

          <Field label="Amount" error={form.formState.errors.amount?.message}>
            <input
              inputMode="decimal"
              placeholder="1,650.00"
              {...form.register('amount')}
              className={inputClass}
            />
          </Field>

          <Field label="First due" error={form.formState.errors.firstDueOn?.message}>
            <input type="date" {...form.register('firstDueOn')} className={inputClass} />
          </Field>

          <Field
            label={direction === 'income' ? 'Into account' : 'From account'}
            error={form.formState.errors.ledgerAccountId?.message}
          >
            <select {...form.register('ledgerAccountId')} className={inputClass}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Category" error={form.formState.errors.categoryId?.message}>
            <select {...form.register('categoryId')} className={inputClass}>
              <option value="">Choose…</option>
              {(categories.data ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Repeats" error={form.formState.errors.frequency?.message}>
            <select {...form.register('frequency')} className={inputClass}>
              {REPEAT_FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {label(frequency)}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              One-off, weekly, every two weeks, or monthly on a day.
            </span>
          </Field>

          <Field label="Ends (optional)" error={form.formState.errors.endsOn?.message}>
            <input type="date" {...form.register('endsOn')} className={inputClass} />
            <span className="mt-1 block text-xs text-slate-500">Leave empty for never.</span>
          </Field>
        </form>
      </Tabs.Root>

      <p className="mt-4 flex items-start gap-2.5 rounded-md bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
        <WarningIcon />
        <span>
          Nothing is added to your ledger now. This schedules it, and it appears in the projection
          until you mark it paid.
        </span>
      </p>

      {problem && (
        <p
          role="alert"
          className="mt-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {problem.detail ?? problem.title}
        </p>
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
