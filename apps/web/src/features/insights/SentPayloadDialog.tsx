import type { SentPayload } from '@pfm/contracts';
import { Modal } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { formatMonthLong } from '../reporting/params.js';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  period: string;
  sent: SentPayload;
};

const TIME = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' });

/**
 * The exact payload, not a description of it. Nothing about this feature has to
 * be taken on trust, and a note that says "merchant names only" is worth less
 * than the list the user can read.
 */
export const SentPayloadDialog = ({ open, onOpenChange, period, sent }: Props) => (
  <Modal
    open={open}
    onOpenChange={onOpenChange}
    title="What was sent"
    footer={
      <Button variant="primary" onClick={() => onOpenChange(false)}>
        Close
      </Button>
    }
  >
    <p className="text-sm text-slate-600">
      {formatMonthLong(period)}, sent at {TIME.format(new Date(sent.at))}. {sent.names.length}{' '}
      {sent.names.length === 1 ? 'name' : 'names'}, nothing else.
    </p>

    <ul className="mt-3 max-h-72 overflow-y-auto rounded-md bg-slate-50 px-3.5 py-3 text-sm leading-7">
      {sent.names.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  </Modal>
);
