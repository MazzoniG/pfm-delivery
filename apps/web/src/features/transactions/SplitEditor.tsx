import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { LockedEntryProblem, type Entry, type EntryLine, type Project } from '@pfm/contracts';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/dialog.js';
import { problemOf } from '../../lib/api.js';
import {
  allocatedMinorUnits,
  formatMinorUnits,
  parseAmountToMinorUnits,
  remainingMinorUnits,
} from '../../lib/money.js';
import { useCategories } from '../accounts/api.js';
import { useProjects } from '../projects/api.js';
import { SplitDetailDrawer } from './SplitDetailDrawer.jsx';
import { useEntry, usePostCorrection, useUpdateEntry } from './api.js';
import { LockIcon, PlusIcon } from './icons.jsx';

type Props = {
  entryId: string;
  /** The paying account: the line the entry is seen from. */
  accountId: string;
  onClose: () => void;
};

/**
 * Amounts are typed as positive decimals, like the add dialog, and the paying
 * account's direction decides every sign at submit.
 */
const amount = z
  .string()
  .refine((value) => (parseAmountToMinorUnits(value) ?? 0n) > 0n, 'Use a format like 24.00');

const FormSchema = z.object({
  total: amount,
  lines: z
    .array(
      z.object({
        categoryId: z.uuid('Choose a category'),
        projectId: z.string(),
        amount,
        excludedFromReporting: z.boolean(),
      }),
    )
    .min(1),
});

type FormValues = z.infer<typeof FormSchema>;

const isCategoryLine = (line: EntryLine) =>
  line.ledgerAccountKind === 'income' || line.ledgerAccountKind === 'expense';

/**
 * The editor handles the shape the register collapses to —Split—: one paying
 * account and category lines all on the other side of it. Anything else, such
 * as a purchase paid from two accounts, stays in the read-only detail rather
 * than being flattened into a shape it was not.
 */
const editableShape = (entry: Entry, accountId: string) => {
  const accountLines = entry.lines.filter((line) => line.ledgerAccountId === accountId);
  const accountLine = accountLines[0];
  if (accountLines.length !== 1 || !accountLine) return null;
  const outflow = accountLine.amountMinor < 0n;
  const counterLines = entry.lines.filter((line) => line !== accountLine);
  const opposite = counterLines.every(
    (line) => isCategoryLine(line) && line.amountMinor < 0n !== outflow,
  );
  return opposite ? { accountLine, counterLines, outflow } : null;
};

export const SplitEditor = ({ entryId, accountId, onClose }: Props) => {
  const entry = useEntry(entryId);
  const expense = useCategories('expense');
  const income = useCategories('income');
  const projects = useProjects();

  // The pickers mount with their options, or a select would render its saved
  // value as blank while the form still holds it.
  const queries = [entry, expense, income, projects];
  const failed = queries.find((query) => query.isError);
  if (!entry.isSuccess || !expense.isSuccess || !income.isSuccess || !projects.isSuccess) {
    return (
      <Modal open onOpenChange={(next) => !next && onClose()} title="Split transaction" wide>
        {failed ? (
          <p role="alert" className="text-sm text-rose-700">
            {problemOf(failed.error)?.detail ?? 'This entry didn’t load.'}
          </p>
        ) : (
          <p className="text-sm text-slate-500">Loading…</p>
        )}
      </Modal>
    );
  }

  const shape = editableShape(entry.data, accountId);
  if (!shape) return <SplitDetailDrawer entryId={entryId} accountId={accountId} onClose={onClose} />;

  const categories = (shape.outflow ? expense : income).data;
  // Every category the entry already names stays choosable, even one of the
  // other kind or since archived, so opening the editor never blanks a line.
  const categoryOptions = [
    ...categories.map((c) => ({ id: c.id, name: c.name })),
    ...shape.counterLines
      .filter((line) => !categories.some((c) => c.id === line.ledgerAccountId))
      .map((line) => ({ id: line.ledgerAccountId, name: line.ledgerAccountName })),
  ];

  return (
    <SplitForm
      entry={entry.data}
      {...shape}
      categoryOptions={categoryOptions}
      projects={projects.data}
      onClose={onClose}
    />
  );
};

const asDate = (iso: string, style: 'medium' | 'short') =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString(
    'en-US',
    style === 'medium'
      ? { dateStyle: 'medium', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', timeZone: 'UTC' },
  );

const SplitForm = ({
  entry,
  accountLine,
  counterLines,
  outflow,
  categoryOptions,
  projects,
  onClose,
}: {
  entry: Entry;
  accountLine: EntryLine;
  counterLines: EntryLine[];
  outflow: boolean;
  categoryOptions: { id: string; name: string }[];
  projects: Project[];
  onClose: () => void;
}) => {
  const update = useUpdateEntry(entry.id);
  const correction = usePostCorrection(entry.id);
  // Known up front from the entry; a 409 on save covers one reconciled since it loaded.
  const [lockedAt, setLockedAt] = useState(entry.lockedAt);

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      // Raw signed amounts, read as positive decimals from the paying side.
      total: formatMinorUnits(outflow ? -accountLine.amountMinor : accountLine.amountMinor),
      lines: counterLines.map((line) => ({
        categoryId: line.ledgerAccountId,
        projectId: line.projectId ?? '',
        amount: formatMinorUnits(outflow ? line.amountMinor : -line.amountMinor),
        excludedFromReporting: line.excludedFromReporting,
      })),
    },
  });
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const values = form.watch();

  const total = parseAmountToMinorUnits(values.total);
  const amounts = values.lines.map((line) => parseAmountToMinorUnits(line.amount));
  const allocated = allocatedMinorUnits(amounts.filter((a): a is bigint => a !== null));
  const remaining = total === null ? null : remainingMinorUnits(total, allocated);

  const reason =
    total === null || total === 0n
      ? 'Enter the total, like 230.00.'
      : values.lines.some((line) => line.categoryId === '')
        ? 'Choose a category for every line.'
        : amounts.some((a) => a === null || a === 0n)
          ? 'Enter an amount above zero on every line.'
          : remaining !== null && remaining > 0n
            ? 'Allocate the full amount to save.'
            : remaining !== null && remaining < 0n
              ? 'The lines add up to more than the total.'
              : null;

  const submit = form.handleSubmit(async (submitted) => {
    const typedTotal = parseAmountToMinorUnits(submitted.total);
    if (typedTotal === null || reason) return;

    const payload = [
      { ledgerAccountId: accountLine.ledgerAccountId, amountMinor: (outflow ? -typedTotal : typedTotal).toString() },
      ...submitted.lines.map((line) => {
        const typed = parseAmountToMinorUnits(line.amount) ?? 0n;
        return {
          ledgerAccountId: line.categoryId,
          amountMinor: (outflow ? typed : -typed).toString(),
          projectId: line.projectId === '' ? null : line.projectId,
          excludedFromReporting: line.excludedFromReporting,
        };
      }),
    ];

    try {
      if (lockedAt) {
        await correction.mutateAsync({
          description: entry.description,
          payee: entry.payee,
          memo: entry.memo,
          lines: payload,
        });
      } else {
        await update.mutateAsync({ lines: payload });
      }
      onClose();
    } catch (error) {
      const locked = LockedEntryProblem.safeParse(problemOf(error));
      if (locked.success) {
        update.reset();
        setLockedAt(locked.data.lockedAt);
      }
    }
  });

  const pending = update.isPending || correction.isPending;
  const problem = problemOf(update.error ?? correction.error);
  const actionLabel = lockedAt ? 'Post correction' : 'Save split';

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title="Split transaction"
      wide
      footer={
        <>
          {reason && (
            <span id="split-why-disabled" className="mr-auto self-center text-xs text-slate-500">
              {reason}
            </span>
          )}
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="split-editor"
            variant="primary"
            disabled={reason !== null || pending}
            aria-describedby={reason ? 'split-why-disabled' : undefined}
          >
            {pending ? (lockedAt ? 'Posting…' : 'Saving…') : actionLabel}
          </Button>
        </>
      }
    >
      {lockedAt && (
        <div className="mb-4 flex gap-2 rounded-md bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <span className="mt-0.5 shrink-0">
            <LockIcon />
          </span>
          <span>
            This transaction was reconciled on {asDate(lockedAt, 'short')}. Saving posts a
            correction dated today; the original stays as reconciled.
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 rounded-md bg-slate-100 px-3 py-2.5 text-sm">
        <span>
          <b className="font-semibold text-slate-900">{entry.payee ?? 'Transaction'}</b>{' '}
          <span className="text-slate-500">{asDate(entry.occurredOn, 'medium')}</span>
        </span>
        <span className="text-slate-500">
          {outflow ? 'Paid from' : 'Paid into'} {accountLine.ledgerAccountName}
        </span>
      </div>

      <form id="split-editor" onSubmit={(event) => void submit(event)}>
        <div className="mb-4 mt-3.5 flex justify-end">
          <label className="block w-44 text-sm">
            <span className="mb-1 block font-medium text-slate-700">Total</span>
            <input inputMode="decimal" {...form.register('total')} className={`${inputClass} tabular-nums`} />
          </label>
        </div>

        <table className="mb-2 w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" className="px-1.5 pb-2 text-left text-xs font-semibold text-slate-500">
                Category
              </th>
              <th scope="col" className="px-1.5 pb-2 text-left text-xs font-semibold text-slate-500">
                Project
              </th>
              <th scope="col" className="w-32 px-1.5 pb-2 text-left text-xs font-semibold text-slate-500">
                Amount
              </th>
              <th scope="col" className="w-9">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.fields.map((field, index) => (
              <tr key={field.id}>
                <td className="px-1.5 py-1 align-top">
                  <select
                    aria-label={`Category, line ${index + 1}`}
                    {...form.register(`lines.${index}.categoryId`)}
                    className={inputClass}
                  >
                    <option value="">Choose…</option>
                    {categoryOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-1.5 py-1 align-top">
                  <select
                    aria-label={`Project, line ${index + 1}`}
                    {...form.register(`lines.${index}.projectId`)}
                    className={inputClass}
                  >
                    <option value="">No project</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-1.5 py-1 align-top">
                  <input
                    aria-label={`Amount, line ${index + 1}`}
                    inputMode="decimal"
                    placeholder="0.00"
                    {...form.register(`lines.${index}.amount`)}
                    className={`${inputClass} tabular-nums`}
                  />
                </td>
                <td className="py-1 align-top">
                  <button
                    type="button"
                    aria-label={`Remove line ${index + 1}`}
                    disabled={lines.fields.length === 1}
                    onClick={() => lines.remove(index)}
                    className="rounded border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button
          type="button"
          onClick={() =>
            lines.append({ categoryId: '', projectId: '', amount: '', excludedFromReporting: false })
          }
          className="inline-flex items-center gap-1.5 px-1.5 py-1 text-sm font-semibold text-emerald-800"
        >
          <PlusIcon />
          Add line
        </button>

        {total !== null && remaining !== null && (
          <div
            role="status"
            className={`mt-2 flex items-center justify-between gap-3 rounded-md px-3.5 py-2.5 text-sm ${
              remaining === 0n ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'
            }`}
          >
            <span>
              {remaining === 0n
                ? 'Fully allocated'
                : remaining > 0n
                  ? `${formatMinorUnits(remaining)} left to allocate`
                  : `${formatMinorUnits(remainingMinorUnits(allocated, total))} more than the total`}
            </span>
            <b className="font-semibold tabular-nums">
              {formatMinorUnits(allocated)} of {formatMinorUnits(total)}
            </b>
          </div>
        )}
      </form>

      {problem && !LockedEntryProblem.safeParse(problem).success && (
        <p role="alert" className="mt-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {problem.detail ?? problem.title}
        </p>
      )}
    </Modal>
  );
};

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M2.5 4h9M5.5 4V2.5h3V4M4 4l.6 7.5h4.8L10 4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const inputClass =
  'w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-emerald-600 focus:outline-none';
