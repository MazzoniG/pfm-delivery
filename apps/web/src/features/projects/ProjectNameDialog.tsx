import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CreateProjectRequest } from '@pfm/contracts';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/dialog.js';
import { problemOf } from '../../lib/api.js';

type Props = {
  title: string;
  submitLabel: string;
  initialName?: string;
  pending: boolean;
  error: unknown;
  onSubmit: (name: string) => Promise<unknown>;
  onClose: () => void;
};

/** Create and rename share it: the name is the only field a project has. */
export const ProjectNameDialog = ({
  title,
  submitLabel,
  initialName = '',
  pending,
  error,
  onSubmit,
  onClose,
}: Props) => {
  const form = useForm<CreateProjectRequest>({
    resolver: zodResolver(CreateProjectRequest),
    defaultValues: { name: initialName },
  });

  // A rejected save stays open; the mutation's error renders below.
  const submit = form.handleSubmit(async ({ name }) => {
    try {
      await onSubmit(name);
      onClose();
    } catch {}
  });

  const problem = problemOf(error);

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title={title}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="project-name" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : submitLabel}
          </Button>
        </>
      }
    >
      <form id="project-name" onSubmit={(event) => void submit(event)}>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Name</span>
          <input
            autoFocus
            {...form.register('name')}
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-emerald-600 focus:outline-none"
          />
          {form.formState.errors.name && (
            <span className="mt-1 block text-xs text-rose-700">Enter a name of up to 80 characters</span>
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
