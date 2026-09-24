import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Project, ProjectList, ProjectReport, routes } from '@pfm/contracts';
import { request } from '../../lib/api.js';

export const useProjects = () =>
  useQuery({
    queryKey: ['projects'],
    queryFn: async () => ProjectList.parse(await request(routes.projects)),
  });

export const useProjectReport = (id: string, from: string, to: string) =>
  useQuery({
    queryKey: ['reports', 'project', id, from, to],
    queryFn: async () =>
      ProjectReport.parse(
        await request(`${routes.projectReport(id)}?${new URLSearchParams({ from, to })}`),
      ),
  });

const refreshProjects = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: ['projects'] }),
    client.invalidateQueries({ queryKey: ['reports'] }),
  ]);

export const useCreateProject = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      Project.parse(
        await request(routes.projects, { method: 'POST', body: JSON.stringify({ name }) }),
      ),
    onSuccess: () => refreshProjects(client),
  });
};

export const useRenameProject = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      Project.parse(
        await request(routes.project(id), { method: 'PATCH', body: JSON.stringify({ name }) }),
      ),
    onSuccess: () => refreshProjects(client),
  });
};

export const useDeleteProject = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await request(routes.project(id), { method: 'DELETE' });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['projects'] }),
  });
};
