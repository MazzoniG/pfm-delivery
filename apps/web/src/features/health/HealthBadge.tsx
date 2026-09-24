import { useQuery } from '@tanstack/react-query';
import { HealthResponse } from '@pfm/contracts';
import { Badge } from '../../components/ui/badge.js';

const fetchHealth = async (): Promise<HealthResponse> => {
  const res = await fetch('/health');
  if (!res.ok) throw new Error(`health returned ${res.status}`);
  return HealthResponse.parse(await res.json());
};

export const HealthBadge = () => {
  const { data, isPending, isError } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: false,
  });

  if (isPending) return <Badge>checking…</Badge>;
  if (isError) return <Badge tone="negative">api down</Badge>;
  return <Badge tone="positive">api up · {data.uptimeSeconds}s</Badge>;
};
