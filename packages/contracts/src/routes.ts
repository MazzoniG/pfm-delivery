export const API_PREFIX = '/api/v1' as const;

export const routes = {
  health: '/health',
  ready: '/ready',
  accounts: '/accounts',
  /** Register this before `/accounts/:id`, or Express parses `balances` as an id. */
  accountBalances: '/accounts/balances',
  account: (id: string) => `/accounts/${id}`,
  accountBalance: (id: string) => `/accounts/${id}/balance`,
  categories: '/categories',
  entries: '/entries',
  entry: (id: string) => `/entries/${id}`,
  entryCorrection: (id: string) => `/entries/${id}/correction`,
  categoryReport: '/reports/categories',
  categoryReportLines: (ledgerAccountId: string) =>
    `/reports/categories/${ledgerAccountId}/lines`,
  projects: '/projects',
  project: (id: string) => `/projects/${id}`,
  projectReport: (id: string) => `/reports/projects/${id}`,
  insightsSpendingReport: '/insights/spending-report',
  insightsSettings: '/insights/settings',
  recurring: '/recurring',
  /** Paying is the only write on an occurrence, so there is no `/occurrences/:id`. */
  occurrencePay: (id: string) => `/occurrences/${id}/pay`,
  projection: '/projection',
} as const;

export const apiPath = (path: string): string => `${API_PREFIX}${path}`;
