import type { ReactNode } from 'react';

type Tone = 'neutral' | 'positive' | 'negative';

const tones: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  positive: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  negative: 'bg-rose-50 text-rose-700 ring-rose-200',
};

export const Badge = ({
  tone = 'neutral',
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) => (
  <span
    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}
  >
    {children}
  </span>
);
