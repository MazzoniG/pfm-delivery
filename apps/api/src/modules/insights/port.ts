import { z } from 'zod';

/**
 * What the model is allowed to answer, and the whole of it: a label, and which
 * of the names it was given belong under it. No amounts, no counts, no ordering
 * — the figures and the ranking are the database's, and a field the model could
 * fill with a number is a field that could end up on screen.
 */
export const ModelGrouping = z.object({
  label: z.string().min(1).max(60),
  payees: z.array(z.string()).min(1),
});
export type ModelGrouping = z.infer<typeof ModelGrouping>;

export const ModelGroupings = z.object({
  groups: z.array(ModelGrouping).max(30),
});
export type ModelGroupings = z.infer<typeof ModelGroupings>;

/**
 * The one seam through which tenant data leaves the process. It takes merchant
 * names and returns groupings of those same names; anything else about the
 * period — what was spent, when, from which account, by whom — cannot reach an
 * implementation of this interface because it is not in the signature.
 *
 * Every failure is a thrown error. The service degrades on all of them
 * identically, so an adapter never has to decide what a failure means.
 */
export type LlmProvider = {
  /** False when the provider cannot run at all, e.g. no API key is configured. */
  available: boolean;
  groupPayees(names: string[]): Promise<ModelGroupings>;
};
