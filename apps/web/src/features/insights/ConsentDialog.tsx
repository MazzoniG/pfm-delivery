import { Modal } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccept: () => void;
  pending: boolean;
};

const Yes = () => <span className="font-bold text-emerald-700">✓</span>;
const No = () => <span className="font-bold text-rose-700">✗</span>;

/**
 * Shown the first time the switch is used, and never as a formality: it names
 * the provider, states what is sent and what is not as two lists, and says the
 * feature is optional and reversible. The second list is the one that answers
 * the worry, so it is not folded into a paragraph.
 */
export const ConsentDialog = ({ open, onOpenChange, onAccept, pending }: Props) => (
  <Modal
    open={open}
    onOpenChange={onOpenChange}
    title="Group spending by meaning"
    footer={
      <>
        <Button onClick={() => onOpenChange(false)}>Not now</Button>
        <Button variant="primary" onClick={onAccept} disabled={pending}>
          {pending ? 'Turning on…' : 'Turn on'}
        </Button>
      </>
    }
  >
    <div className="space-y-3 text-sm text-slate-600">
      <p>
        Name matching groups the same merchant written two ways. Grouping by meaning also
        puts different merchants together when they are the same kind of spending, such as
        a taxi company and a rideshare app.
      </p>

      <p className="font-semibold text-slate-900">This sends merchant names to Anthropic’s API</p>

      <ul className="space-y-1.5">
        <li className="flex gap-2.5">
          <Yes />
          <span>Merchant names, as they appear on your transactions</span>
        </li>
        <li className="flex gap-2.5">
          <No />
          <span>Amounts, dates, accounts, balances, or your name</span>
        </li>
      </ul>

      <p>
        Amounts are totalled here, on the server, after the grouping comes back. You can
        turn this off at any time, and the report works without it.
      </p>
    </div>
  </Modal>
);
