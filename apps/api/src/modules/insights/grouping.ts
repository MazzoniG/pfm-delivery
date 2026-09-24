import type { PayeeGroupRow } from '../reporting/similar-groups.sql.js';
import type { ModelGroupings } from './port.js';

export const OTHER_LABEL = 'Other';

/** A group of SQL rows, still in ledger signs. Ranking and display belong to the mapper. */
export type SemanticGroup = {
  label: string;
  origin: 'model' | 'other';
  payees: PayeeGroupRow[];
};

export const sumRows = (rows: readonly PayeeGroupRow[]): bigint =>
  rows.reduce((total, row) => total + row.totalMinor, 0n);

/**
 * Folds the model's grouping of names onto the SQL rows, and refuses it if it
 * does not describe exactly the names it was given.
 *
 * The model's answer is input from outside the process, and the names in it
 * came from merchants, so it is checked rather than trusted: an unknown name
 * means the model invented or altered one, and a repeated name would count a
 * merchant's spending twice. Either is a rejection, not a repair — a report
 * that silently corrects a wrong answer cannot be told from one that was right.
 *
 * Throws on rejection. The caller degrades to name matching on any throw.
 */
export const applyGrouping = (
  rows: PayeeGroupRow[],
  grouping: ModelGroupings,
): SemanticGroup[] => {
  const byPayee = new Map(rows.map((row) => [row.payee, row]));
  const claimed = new Set<string>();

  const groups: SemanticGroup[] = grouping.groups.map((group) => {
    const payees = group.payees.map((name) => {
      const row = byPayee.get(name);
      if (row === undefined) throw new Error(`model named a payee that was not sent: ${name}`);
      if (claimed.has(name)) throw new Error(`model placed a payee in two groups: ${name}`);
      claimed.add(name);
      return row;
    });
    return { label: group.label, origin: 'model' as const, payees };
  });

  const ungrouped = rows.filter((row) => !claimed.has(row.payee));
  if (ungrouped.length > 0) {
    groups.push({ label: OTHER_LABEL, origin: 'other' as const, payees: ungrouped });
  }

  return groups;
};
