import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

const Close = () => (
  <Dialog.Close
    aria-label="Close"
    className="rounded p-1 text-slate-500 hover:bg-slate-100"
  >
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="m2 2 8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  </Dialog.Close>
);

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** A drawer slides in from the right; the split detail is one. */
  side?: 'center' | 'right';
  /** The split editor's line table needs the room. */
  wide?: boolean;
};

export const Modal = ({
  open,
  onOpenChange,
  title,
  children,
  footer,
  side = 'center',
  wide = false,
}: Props) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-30 bg-slate-900/30" />
      <Dialog.Content
        className={
          side === 'right'
            ? 'fixed inset-y-0 right-0 z-30 flex w-[22rem] flex-col bg-white shadow-xl'
            : `fixed left-1/2 top-1/2 z-30 flex ${wide ? 'w-[40rem]' : 'w-[30rem]'} max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-white shadow-xl`
        }
      >
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-3">
          <Dialog.Title className="text-base font-semibold text-slate-900">
            {title}
          </Dialog.Title>
          <Close />
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
            {footer}
          </div>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);
