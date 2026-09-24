import type { LedgerAccountKind } from '@prisma/client';

/**
 * Every user gets their own `Equity:Opening Balances`. It is per-user because a
 * single global row would be readable across tenants, and it is created here
 * only because the seed is one place a user comes into existence — **wherever
 * else a user is created, this account has to be created with it.** A user
 * without it cannot be given an opening balance at all.
 */
export const SYSTEM_ACCOUNT = {
  name: 'Opening Balances',
  kind: 'equity',
} as const;

export type AccountSpec = {
  key: string;
  name: string;
  kind: LedgerAccountKind;
};

export const DEMO_ACCOUNTS: readonly AccountSpec[] = [
  { key: 'checking', name: 'Everyday Checking', kind: 'asset' },
  { key: 'savings', name: 'High-Yield Savings', kind: 'asset' },
  { key: 'visa', name: 'Visa Credit Card', kind: 'liability' },
];

export const DEMO_INCOME: readonly AccountSpec[] = [
  { key: 'salary', name: 'Salary', kind: 'income' },
  { key: 'freelance', name: 'Freelance', kind: 'income' },
  { key: 'interest', name: 'Interest', kind: 'income' },
];

export type ExpenseSpec = AccountSpec & {
  payees: readonly string[];
  minCents: number;
  maxCents: number;
  /** Eligible for day-to-day spending. The rest are posted on a schedule. */
  everyday: boolean;
};

export const DEMO_EXPENSES: readonly ExpenseSpec[] = [
  { key: 'groceries', name: 'Groceries', kind: 'expense', everyday: true, minCents: 1800, maxCents: 12400, payees: ['Corner Market', 'Greenfield Grocers', 'Harvest Foods'] },
  { key: 'dining', name: 'Dining', kind: 'expense', everyday: true, minCents: 1100, maxCents: 7600, payees: ['Riverside Café', 'Noodle House', 'The Copper Kettle'] },
  { key: 'transport', name: 'Transport', kind: 'expense', everyday: true, minCents: 400, maxCents: 6200, payees: ['Metro Transit', 'Shell Station', 'City Cabs'] },
  { key: 'household', name: 'Household', kind: 'expense', everyday: true, minCents: 900, maxCents: 4600, payees: ['Maple Street Hardware', 'Bright Home Goods'] },
  { key: 'entertainment', name: 'Entertainment', kind: 'expense', everyday: true, minCents: 900, maxCents: 5400, payees: ['Regal Cinema', 'Vinyl & Co', 'Riverside Theatre'] },
  { key: 'health', name: 'Health', kind: 'expense', everyday: true, minCents: 1500, maxCents: 9200, payees: ['Northside Pharmacy', 'Dr Alvarez', 'Clearview Dental'] },
  { key: 'clothing', name: 'Clothing', kind: 'expense', everyday: true, minCents: 2500, maxCents: 14800, payees: ['Fieldstone Outfitters', 'Ada & Sons'] },
  { key: 'pets', name: 'Pets', kind: 'expense', everyday: true, minCents: 1200, maxCents: 6400, payees: ['Paws & Whiskers', 'Riverside Vet'] },
  { key: 'gifts', name: 'Gifts', kind: 'expense', everyday: true, minCents: 2000, maxCents: 9800, payees: ['Paper Lantern', 'The Bookshop'] },
  { key: 'home-improvement', name: 'Home Improvement', kind: 'expense', everyday: false, minCents: 4500, maxCents: 38000, payees: ['Maple Street Hardware', 'Timberline Supply'] },
  { key: 'rent', name: 'Rent', kind: 'expense', everyday: false, minCents: 165000, maxCents: 165000, payees: ['Harbor Apartments'] },
  { key: 'utilities', name: 'Utilities', kind: 'expense', everyday: false, minCents: 6200, maxCents: 13400, payees: ['City Power & Light'] },
  { key: 'internet', name: 'Phone & Internet', kind: 'expense', everyday: false, minCents: 6500, maxCents: 8500, payees: ['Northlink Fibre'] },
  { key: 'subscriptions', name: 'Subscriptions', kind: 'expense', everyday: false, minCents: 999, maxCents: 2499, payees: ['Streamline Media', 'Cloud Drive'] },
  { key: 'insurance', name: 'Insurance', kind: 'expense', everyday: false, minCents: 8400, maxCents: 14200, payees: ['Meridian Insurance'] },
  { key: 'fitness', name: 'Fitness', kind: 'expense', everyday: false, minCents: 3500, maxCents: 3500, payees: ['Ironworks Gym'] },
  { key: 'travel', name: 'Travel', kind: 'expense', everyday: false, minCents: 12000, maxCents: 48000, payees: ['Coastline Rail', 'Hotel Verde'] },
  { key: 'education', name: 'Education', kind: 'expense', everyday: false, minCents: 4000, maxCents: 19500, payees: ['Open Learning Co'] },
];
