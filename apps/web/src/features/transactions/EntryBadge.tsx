import type { ReactNode } from 'react';

const tones = {
  correction: 'bg-amber-50 text-amber-800 ring-amber-200',
  reversal: 'bg-slate-100 text-slate-600 ring-slate-200',
} as const;

export type EntryBadgeTone = keyof typeof tones;

export const EntryBadge = ({ tone, children }: { tone: EntryBadgeTone; children: ReactNode }) => (
  <span
    className={`ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tones[tone]}`}
  >
    {children}
  </span>
);
