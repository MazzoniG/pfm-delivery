import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';

const variants: Record<Variant, string> = {
  primary:
    'bg-emerald-700 text-white hover:bg-emerald-800 focus-visible:outline-emerald-700',
  secondary:
    'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50',
  ghost: 'text-slate-600 hover:bg-slate-100',
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant };

export const Button = ({ variant = 'secondary', className = '', ...props }: Props) => (
  <button
    {...props}
    className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${className}`}
  />
);
