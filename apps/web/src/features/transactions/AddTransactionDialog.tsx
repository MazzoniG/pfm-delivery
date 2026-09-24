import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CalendarDate, type LedgerAccount } from '@pfm/contracts';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/dialog.js';
import { parseAmountToMinorUnits } from '../../lib/money.js';
import { problemOf } from '../../lib/api.js';
import { useCategories } from '../accounts/api.js';
import { useProjects } from '../projects/api.js';
import { useCreateEntry } from './api.js';

type Direction = 'out' | 'in' | 'transfer';

/**
 * The form's own shape, not the API's. The amount is typed as a positive
 * decimal and the tab decides the sign; the contract's `amountMinor` string is
 * built from it at submit, by string manipulation and never through a number.
 */
const FormSchema = z.object({
  occurredOn: CalendarDate,
  amount: z
    .string()
    .min(1, 'Enter an amount')
    .refine((value) => parseAmountToMinorUnits(value) !== null, 'Use a format like 24.00')
    .refine((value) => parseAmountToMinorUnits(value) !== 0n, 'Enter an amount above zero'),
  payee: z.string().trim().max(120).optional(),
  accountId: z.uuid('Choose an account'),
  counterId: z.uuid('Choose a category'),
  projectId: z.string(),
  memo: z.string().trim().max(500).optional(),
});

type FormValues = z.infer<typeof FormSchema>;

const today = (): string => new Date().toISOString().slice(0, 10);

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: LedgerAccount[];
  defaultAccountId: string;
};

export const AddTransactionDialog = ({
  open,
  onOpenChange,
  accounts,
  defaultAccountId,
}: Props) => {
  const [direction, setDirection] = useState<Direction>('out');
  const create = useCreateEntry();
  const categories = useCategories(direction === 'in' ? 'income' : 'expense');
  const projects = useProjects();

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      occurredOn: today(),
      amount: '',
      accountId: defaultAccountId,
      counterId: '',
      projectId: '',
    },
  });

  const counterOptions =
    direction === 'transfer'
      ? accounts.filter((account) => account.id !== form.watch('accountId'))
      : (categories.data ?? []);

  const submit = form.handleSubmit(async (values) => {
    const magnitude = parseAmountToMinorUnits(values.amount);
    if (magnitude === null) return;

    // Money out leaves the account, money in arrives; a transfer is the same
    // thing with an account on the other side instead of a category.
    const signed = direction === 'in' ? magnitude : -magnitude;
    const header = {
      occurredOn: values.occurredOn,
      payee: values.payee ?? null,
      memo: values.memo ?? null,
    };

    const body =
      direction === 'transfer'
        ? {
            ...header,
            lines: [
              { ledgerAccountId: values.accountId, amountMinor: signed.toString() },
              { ledgerAccountId: values.counterId, amountMinor: (-signed).toString() },
            ],
          }
        : {
            ...header,
            accountId: values.accountId,
            categoryId: values.counterId,
            amountMinor: signed.toString(),
            projectId: values.projectId === '' ? null : values.projectId,
          };

    // A rejected post keeps the dialog open; the mutation's error renders below.
    try {
      await create.mutateAsync(body);
    } catch {
      return;
    }
    form.reset({
      occurredOn: today(),
      amount: '',
      accountId: values.accountId,
      counterId: '',
      projectId: '',
    });
    onOpenChange(false);
  });

  const problem = problemOf(create.error);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add transaction"
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-transaction"
            variant="primary"
            disabled={create.isPending}
          >
            {create.isPending ? 'Saving…' : 'Add transaction'}
          </Button>
        </>
      }
    >
      <Tabs.Root value={direction} onValueChange={(value) => setDirection(value as Direction)}>
        <Tabs.List className="mb-4 inline-flex rounded-md bg-slate-100 p-1">
          {(
            [
              ['out', 'Money out'],
              ['in', 'Money in'],
              ['transfer', 'Transfer'],
            ] as const
          ).map(([value, label]) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className="rounded px-3 py-1 text-sm data-[state=active]:bg-white data-[state=active]:font-semibold data-[state=active]:shadow-sm"
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <form id="add-transaction" onSubmit={submit} className="grid grid-cols-2 gap-4">
          <Field label="Date" error={form.formState.errors.occurredOn?.message}>
            <input type="date" {...form.register('occurredOn')} className={inputClass} />
          </Field>

          <Field label="Amount" error={form.formState.errors.amount?.message}>
            <input
              inputMode="decimal"
              placeholder="24.00"
              {...form.register('amount')}
              className={inputClass}
            />
          </Field>

          <Field label="Payee" error={form.formState.errors.payee?.message}>
            <input placeholder="Who was paid" {...form.register('payee')} className={inputClass} />
          </Field>

          <Field
            label={direction === 'transfer' ? 'From account' : 'Account'}
            error={form.formState.errors.accountId?.message}
          >
            <select {...form.register('accountId')} className={inputClass}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label={direction === 'transfer' ? 'To account' : 'Category'}
            error={form.formState.errors.counterId?.message}
          >
            <select {...form.register('counterId')} className={inputClass}>
              <option value="">Choose…</option>
              {counterOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </Field>

          {/* A transfer's lines are both accounts, and a project belongs only on a category line. */}
          {direction !== 'transfer' && (
            <Field label="Project (optional)">
              <select {...form.register('projectId')} className={inputClass}>
                <option value="">No project</option>
                {(projects.data ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Memo (optional)" error={form.formState.errors.memo?.message} wide>
            <input placeholder="Add a note" {...form.register('memo')} className={inputClass} />
          </Field>
        </form>
      </Tabs.Root>

      {problem && (
        <p role="alert" className="mt-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
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
