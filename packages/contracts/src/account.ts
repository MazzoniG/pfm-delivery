import { z } from 'zod';
import { Timestamp, Uuid } from './common.js';

export const AccountKind = z.enum(['asset', 'liability']);
export type AccountKind = z.infer<typeof AccountKind>;

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code');

export const AccountName = z.string().trim().min(1).max(80);

export const LedgerAccount = z.object({
  id: Uuid,
  name: AccountName,
  kind: AccountKind,
  currency: CurrencyCode,
  isSystem: z.boolean(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type LedgerAccount = z.infer<typeof LedgerAccount>;

export const AccountList = z.array(LedgerAccount);

export const CreateAccountRequest = z.object({
  name: AccountName,
  kind: AccountKind,
  currency: CurrencyCode.default('USD'),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;

/**
 * Only the name is patchable. Kind and currency are already baked into the sign
 * and the meaning of every line posted to the account; changing either would
 * silently rewrite history rather than edit a label.
 */
export const UpdateAccountRequest = z.object({ name: AccountName });
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

export const AccountIdParam = z.object({ id: Uuid });
export type AccountIdParam = z.infer<typeof AccountIdParam>;
