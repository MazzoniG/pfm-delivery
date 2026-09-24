import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type { EntryWire, ProjectListWire } from '@pfm/contracts';
import { SplitEditor } from './SplitEditor.jsx';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ENTRY = '10000000-0000-4000-8000-000000000001';
const CHECKING = '11111111-1111-4111-8111-111111111111';
const HOME = '33333333-3333-4333-8333-333333333333';
const HOUSEHOLD = '44444444-4444-4444-8444-444444444444';
const REMODEL = '55555555-5555-4555-8555-555555555555';

const line = (over: Partial<EntryWire['lines'][number]>): EntryWire['lines'][number] => ({
  id: crypto.randomUUID(),
  ledgerAccountId: HOME,
  ledgerAccountName: 'Home Improvement',
  ledgerAccountKind: 'expense',
  amountMinor: '20000',
  projectId: null,
  excludedFromReporting: false,
  reconciledAt: null,
  ...over,
});

const entry = (over: Partial<EntryWire> = {}): EntryWire => ({
  id: ENTRY,
  occurredOn: '2026-09-19',
  description: null,
  payee: 'Maple Street Hardware',
  memo: null,
  lockedAt: null,
  reversesEntryId: null,
  replacesEntryId: null,
  reversedByEntryId: null,
  recordedAt: '2026-09-19T10:00:00.000Z',
  lines: [
    line({ ledgerAccountId: CHECKING, ledgerAccountName: 'Everyday Checking', ledgerAccountKind: 'asset', amountMinor: '-23000' }),
    line({ amountMinor: '20000', projectId: REMODEL }),
    line({ ledgerAccountId: HOUSEHOLD, ledgerAccountName: 'Household', amountMinor: '3000' }),
  ],
  ...over,
});

const projects: ProjectListWire = [
  {
    id: REMODEL,
    name: 'House remodel',
    createdAt: '2026-07-01T09:00:00.000Z',
    netCostMinor: '148640',
    transactionCount: 4,
    firstActivityOn: '2026-07-29',
    lastActivityOn: '2026-09-19',
  },
];

const category = (id: string, name: string) => ({
  id,
  name,
  kind: 'expense',
  isSystem: false,
  archivedAt: null,
  createdAt: '2026-04-01T09:00:00.000Z',
});

const renderEditor = (body: EntryWire, sent: { method: string; path: string; body: unknown }[] = []) => {
  server.use(
    http.get('*/api/v1/entries/:id', () => HttpResponse.json(body)),
    http.get('*/api/v1/projects', () => HttpResponse.json(projects)),
    http.get('*/api/v1/categories', () =>
      HttpResponse.json([category(HOME, 'Home Improvement'), category(HOUSEHOLD, 'Household')]),
    ),
    http.patch('*/api/v1/entries/:id', async ({ request }) => {
      sent.push({ method: 'PATCH', path: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json(body);
    }),
    http.post('*/api/v1/entries/:id/correction', async ({ request }) => {
      sent.push({ method: 'POST', path: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json({ original: body, reversal: body, replacement: body });
    }),
  );

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SplitEditor entryId={ENTRY} accountId={CHECKING} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return sent;
};

const saveButton = () => screen.getByRole('button', { name: /Save split|Post correction/ });

describe('split editor', () => {
  it('opens balanced, with the paying account fixed and carrying no project control', async () => {
    renderEditor(entry());

    expect(await screen.findByText('Paid from Everyday Checking')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Fully allocated');
    expect(screen.getByRole('status')).toHaveTextContent('230.00 of 230.00');
    // One project picker per category line, none for the paying account.
    expect(screen.getAllByRole('combobox', { name: /^Project/ })).toHaveLength(2);
    expect(screen.getByRole('combobox', { name: 'Project, line 1' })).toHaveValue(REMODEL);
    expect(screen.getByRole('combobox', { name: 'Project, line 2' })).toHaveValue('');
    expect(saveButton()).toBeEnabled();
  });

  it('keeps Save disabled, and says why, until the lines equal the total', async () => {
    renderEditor(entry());

    const second = await screen.findByRole('textbox', { name: 'Amount, line 2' });
    fireEvent.change(second, { target: { value: '10.00' } });

    expect(screen.getByRole('status')).toHaveTextContent('20.00 left to allocate');
    expect(screen.getByRole('status')).toHaveTextContent('210.00 of 230.00');
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAccessibleDescription('Allocate the full amount to save.');

    fireEvent.change(second, { target: { value: '50.00' } });
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('20.00 more than the total');

    fireEvent.change(second, { target: { value: '30.00' } });
    expect(saveButton()).toBeEnabled();
  });

  it('names a missing category as the reason once a blank line is added', async () => {
    renderEditor(entry());

    fireEvent.click(await screen.findByRole('button', { name: 'Add line' }));

    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAccessibleDescription('Choose a category for every line.');
  });

  it('saves the explicit lines through PATCH, signed from the paying side', async () => {
    const sent = renderEditor(entry());

    const first = await screen.findByRole('textbox', { name: 'Amount, line 1' });
    fireEvent.change(first, { target: { value: '190.00' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount, line 2' }), { target: { value: '40.00' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      method: 'PATCH',
      path: `/api/v1/entries/${ENTRY}`,
      body: {
        lines: [
          { ledgerAccountId: CHECKING, amountMinor: '-23000' },
          { ledgerAccountId: HOME, amountMinor: '19000', projectId: REMODEL, excludedFromReporting: false },
          { ledgerAccountId: HOUSEHOLD, amountMinor: '4000', projectId: null, excludedFromReporting: false },
        ],
      },
    });
  });

  it('turns a reconciled entry into a correction, posted as Post correction', async () => {
    const sent = renderEditor(entry({ lockedAt: '2026-09-19T12:00:00.000Z' }));

    expect(await screen.findByText(/was reconciled on Sep 19/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save split' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Post correction' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.path).toBe(`/api/v1/entries/${ENTRY}/correction`);
    expect(sent[0]?.body).toMatchObject({
      replacement: { payee: 'Maple Street Hardware', lines: expect.any(Array) },
    });
  });

  it('switches to the correction path when a save meets the lock', async () => {
    renderEditor(entry());
    server.use(
      http.patch('*/api/v1/entries/:id', () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Entry is locked',
            status: 409,
            detail: 'This entry is reconciled.',
            lockedAt: '2026-09-20T12:00:00.000Z',
            correction: `/api/v1/entries/${ENTRY}/correction`,
          },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Save split' }));

    expect(await screen.findByRole('button', { name: 'Post correction' })).toBeInTheDocument();
    expect(screen.getByText(/was reconciled on Sep 20/)).toBeInTheDocument();
  });

  it('leaves a split paid from two accounts in the read-only detail', async () => {
    const VISA = '66666666-6666-4666-8666-666666666666';
    renderEditor(
      entry({
        lines: [
          line({ ledgerAccountId: CHECKING, ledgerAccountName: 'Everyday Checking', ledgerAccountKind: 'asset', amountMinor: '-13000' }),
          line({ ledgerAccountId: VISA, ledgerAccountName: 'Visa Credit Card', ledgerAccountKind: 'liability', amountMinor: '-10000' }),
          line({ amountMinor: '23000' }),
        ],
      }),
    );

    expect(await screen.findByText('Split across')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save split/ })).not.toBeInTheDocument();
  });
});
