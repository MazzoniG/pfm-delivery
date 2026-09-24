import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { HealthBadge } from './HealthBadge.js';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const renderBadge = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <HealthBadge />
    </QueryClientProvider>,
  );

describe('HealthBadge', () => {
  it('reports the api as up when /health responds', async () => {
    server.use(
      http.get('*/health', () =>
        HttpResponse.json({ status: 'ok', uptimeSeconds: 42 }),
      ),
    );

    renderBadge();

    expect(await screen.findByText(/api up/)).toBeInTheDocument();
  });

  it('reports the api as down when /health fails', async () => {
    server.use(
      http.get('*/health', () => new HttpResponse(null, { status: 503 })),
    );

    renderBadge();

    expect(await screen.findByText(/api down/)).toBeInTheDocument();
  });
});
