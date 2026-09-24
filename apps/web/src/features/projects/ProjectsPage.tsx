import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { NavRail } from '../../components/NavRail.jsx';
import { Button } from '../../components/ui/button.js';
import { problemOf } from '../../lib/api.js';
import { formatMinorUnits } from '../../lib/money.js';
import { AccountsSidebar } from '../accounts/AccountsSidebar.js';
import { PlusIcon } from '../transactions/icons.jsx';
import { ProjectNameDialog } from './ProjectNameDialog.jsx';
import { useCreateProject, useProjects } from './api.js';
import { projectActivity } from './format.js';

export const ProjectsPage = () => {
  const navigate = useNavigate();
  const projects = useProjects();
  const create = useCreateProject();
  const [creating, setCreating] = useState(false);

  const newProject = (
    <Button variant="primary" onClick={() => setCreating(true)}>
      <PlusIcon />
      New project
    </Button>
  );

  return (
    <div className="flex min-h-screen bg-slate-50">
      <NavRail />
      <AccountsSidebar
        selectedId={null}
        onSelect={(account) => void navigate(`/transactions?account=${account.id}`)}
      />

      <main className="min-w-0 flex-1 px-6 py-5">
        <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Projects</h1>
            <p className="text-sm text-slate-500">Spending tracked across every account</p>
          </div>
          {newProject}
        </header>

        {projects.isPending && (
          <div aria-busy="true" className="space-y-3">
            {[0, 1, 2].map((n) => (
              <div key={n} className="grid grid-cols-[1fr_7rem] gap-4 border-b border-slate-100 py-3">
                <div className="h-3 w-2/5 rounded bg-slate-100 motion-safe:animate-pulse" />
                <div className="h-3 rounded bg-slate-100 motion-safe:animate-pulse" />
              </div>
            ))}
            <span className="sr-only">Loading projects</span>
          </div>
        )}

        {projects.isError && (
          <div className="flex min-h-52 flex-col items-start justify-center gap-2.5">
            <h2 className="text-base font-semibold text-slate-900">Projects didn’t load</h2>
            <p role="alert" className="w-full rounded bg-rose-50 px-2.5 py-2 text-sm text-rose-800">
              {problemOf(projects.error)?.detail ?? 'Something went wrong.'}
            </p>
            <Button onClick={() => void projects.refetch()}>Try again</Button>
          </div>
        )}

        {projects.isSuccess && projects.data.length === 0 && (
          <div className="flex min-h-52 flex-col items-start justify-center gap-2.5">
            <h2 className="text-base font-semibold text-slate-900">No projects yet</h2>
            <p className="max-w-md text-sm text-slate-500">
              Create one to follow spending that belongs together, like a renovation or a trip,
              across every account.
            </p>
            {newProject}
          </div>
        )}

        {projects.isSuccess && projects.data.length > 0 && (
          <table className="w-full border-collapse">
            <caption className="sr-only">Projects</caption>
            <thead>
              <tr className="border-b border-slate-300">
                <th scope="col" className="px-2.5 pb-2 text-left text-xs font-semibold text-slate-500">
                  Project
                </th>
                <th scope="col" className="w-44 px-2.5 pb-2 text-right text-xs font-semibold text-slate-500">
                  Net cost, USD
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.data.map((project) => (
                <tr
                  key={project.id}
                  onClick={() => void navigate(`/projects/${project.id}`)}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-2.5 py-3.5">
                    <Link to={`/projects/${project.id}`} className="font-semibold text-slate-900 hover:underline">
                      {project.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-slate-500">{projectActivity(project)}</p>
                  </td>
                  <td className="px-2.5 py-3.5 text-right tabular-nums text-slate-900">
                    {formatMinorUnits(project.netCostMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>

      {creating && (
        <ProjectNameDialog
          title="New project"
          submitLabel="Create project"
          pending={create.isPending}
          error={create.error}
          onSubmit={(name) => create.mutateAsync(name)}
          onClose={() => {
            create.reset();
            setCreating(false);
          }}
        />
      )}
    </div>
  );
};
