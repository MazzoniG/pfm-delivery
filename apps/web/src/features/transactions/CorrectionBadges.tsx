import { Link } from 'react-router';
import type { EntryRef } from '@pfm/contracts';
import { formatDayShort } from '../reporting/params.js';
import { EntryBadge } from './EntryBadge.jsx';

type Props = {
  reverses: EntryRef | null;
  reversedBy: EntryRef | null;
  replaces: EntryRef | null;
  /** Where a badge's date links to; without it the badges are plain text. */
  linkTo?: (occurredOn: string) => string;
};

/**
 * A reversal is a negative line by design. Without these, a project or a
 * category with a corrected purchase reads as an error rather than a correction.
 */
export const CorrectionBadges = ({ reverses, reversedBy, replaces, linkTo }: Props) => {
  const label = (text: string, ref: EntryRef) =>
    linkTo ? (
      <Link to={linkTo(ref.occurredOn)} className="underline">
        {text}
      </Link>
    ) : (
      text
    );

  return (
    <>
      {replaces && (
        <EntryBadge tone="correction">
          {label(`Correction of ${formatDayShort(replaces.occurredOn)}`, replaces)}
        </EntryBadge>
      )}
      {reverses && (
        <EntryBadge tone="reversal">
          {label(`Reversal of ${formatDayShort(reverses.occurredOn)}`, reverses)}
        </EntryBadge>
      )}
      {reversedBy && (
        <EntryBadge tone="reversal">
          {label(`Reversed ${formatDayShort(reversedBy.occurredOn)}`, reversedBy)}
        </EntryBadge>
      )}
    </>
  );
};
