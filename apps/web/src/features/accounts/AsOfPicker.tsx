import * as Popover from '@radix-ui/react-popover';
import { useState } from 'react';
import {
  endOfLastMonth,
  localIsoDate,
  parseIsoDate,
  type AsOfState,
} from './asOf.js';
import { CalendarIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from './icons.jsx';

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });
const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

type CalendarProps = {
  asOf: string;
  today: string;
  onPick: (date: string) => void;
};

const Calendar = ({ asOf, today, onPick }: CalendarProps) => {
  const selected = parseIsoDate(asOf) ?? new Date();
  const [view, setView] = useState({
    year: selected.getFullYear(),
    month: selected.getMonth(),
  });

  const first = new Date(view.year, view.month, 1);
  const blanks = (first.getDay() + 6) % 7;
  const dayCount = new Date(view.year, view.month + 1, 0).getDate();
  const nextMonthDisabled = localIsoDate(new Date(view.year, view.month + 1, 1)) > today;

  const step = (by: number) =>
    setView(({ year, month }) => {
      const moved = new Date(year, month + by, 1);
      return { year: moved.getFullYear(), month: moved.getMonth() };
    });

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => step(-1)}
          className="rounded border border-slate-300 p-1.5 text-slate-600 hover:bg-emerald-50"
        >
          <ChevronLeftIcon />
        </button>
        <b className="text-sm font-semibold text-slate-900">{MONTH_LABEL.format(first)}</b>
        <button
          type="button"
          aria-label="Next month"
          disabled={nextMonthDisabled}
          onClick={() => step(1)}
          className="rounded border border-slate-300 p-1.5 text-slate-600 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRightIcon />
        </button>
      </div>

      <div
        role="group"
        aria-label={MONTH_LABEL.format(first)}
        className="grid grid-cols-7 gap-0.5 text-center"
      >
        {WEEKDAYS.map((day) => (
          <div key={day} className="py-1 text-[11px] font-semibold text-slate-400">
            {day}
          </div>
        ))}
        {Array.from({ length: blanks }, (_, i) => (
          <div key={`blank-${i}`} className="h-8" />
        ))}
        {Array.from({ length: dayCount }, (_, i) => {
          const date = new Date(view.year, view.month, i + 1);
          const iso = localIsoDate(date);
          const isToday = iso === today;

          return (
            <button
              key={iso}
              type="button"
              aria-label={DAY_LABEL.format(date)}
              aria-current={isToday ? 'date' : undefined}
              aria-pressed={iso === asOf}
              // A date after today would be a projection, not a balance.
              disabled={iso > today}
              onClick={() => onPick(iso)}
              className={`h-8 rounded text-sm tabular-nums disabled:cursor-not-allowed disabled:text-slate-300 disabled:line-through ${
                iso === asOf
                  ? 'bg-emerald-700 font-semibold text-white'
                  : 'text-slate-700 hover:bg-emerald-50'
              } ${isToday && iso !== asOf ? 'font-semibold ring-1 ring-emerald-700 ring-inset' : ''}`}
            >
              {i + 1}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-slate-400">
        Dates after today show a projection, not a balance.
      </p>
    </>
  );
};

export const AsOfPicker = ({ asOf, today, isPast, label, select, backToToday }: AsOfState) => {
  const [open, setOpen] = useState(false);
  const lastMonth = endOfLastMonth(new Date());

  const pick = (date: string) => {
    select(date);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={`Balances as of ${label}`}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-semibold ${
          isPast
            ? 'border-emerald-700 bg-emerald-50 text-emerald-800'
            : 'border-slate-300 bg-white text-slate-800 hover:bg-emerald-50'
        }`}
      >
        <CalendarIcon />
        {label}
        <ChevronDownIcon />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          aria-label="Choose a date"
          align="end"
          sideOffset={6}
          className="z-30 w-[19rem] rounded-lg border border-slate-300 bg-white p-3.5 shadow-lg"
        >
          <div role="group" aria-label="Quick picks" className="mb-3 flex gap-2">
            <button
              type="button"
              aria-pressed={!isPast}
              onClick={() => {
                backToToday();
                setOpen(false);
              }}
              className={`h-7 rounded-full border px-3 text-xs font-semibold ${
                !isPast
                  ? 'border-emerald-700 bg-emerald-700 text-white'
                  : 'border-slate-300 bg-white text-slate-700'
              }`}
            >
              Today
            </button>
            <button
              type="button"
              aria-pressed={asOf === lastMonth}
              onClick={() => pick(lastMonth)}
              className={`h-7 rounded-full border px-3 text-xs font-semibold ${
                asOf === lastMonth
                  ? 'border-emerald-700 bg-emerald-700 text-white'
                  : 'border-slate-300 bg-white text-slate-700'
              }`}
            >
              End of last month
            </button>
          </div>

          <Calendar asOf={asOf} today={today} onPick={pick} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
