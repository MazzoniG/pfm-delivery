import { Link, NavLink } from 'react-router';

const items = [
  {
    to: '/transactions',
    label: 'Transactions',
    icon: (
      <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 4h8M5 8h8M5 12h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="2.5" cy="4" r="1" fill="currentColor" />
        <circle cx="2.5" cy="8" r="1" fill="currentColor" />
        <circle cx="2.5" cy="12" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    to: '/bills',
    label: 'Bills',
    icon: (
      <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3 2h10v12l-2-1.2L9 14l-2-1.2L5 14l-2-1.2z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M5.5 5.5h5M5.5 8h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: '/reports/categories',
    label: 'Reports',
    icon: (
      <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 14h12M4 12V8M8 12V4M12 12V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: '/projects',
    label: 'Projects',
    icon: (
      <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    to: '/insights',
    label: 'Insights',
    icon: (
      <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 1.5 9.4 5.6 13.5 7 9.4 8.4 8 12.5 6.6 8.4 2.5 7l4.1-1.4z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

export const NavRail = () => (
  <div className="rail">
    <div className="rail-panel flex flex-col gap-1.5 border-r border-slate-200 bg-slate-100 px-2.5 py-4">
      <Link
        to="/"
        aria-label="Ledger, home"
        className="mb-3.5 flex h-10 items-center gap-3 text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
      >
        <span className="flex size-10 flex-none items-center justify-center rounded-[10px] bg-emerald-700 text-xl font-semibold text-white">
          L
        </span>
        <span className="rail-label text-lg font-semibold">Ledger</span>
      </Link>

      <nav aria-label="Main" className="flex flex-col gap-1.5">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            aria-label={item.label}
            className={({ isActive }) =>
              `flex h-10 items-center gap-3 rounded-lg text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 ${
                isActive
                  ? 'bg-emerald-50 text-emerald-800'
                  : 'text-slate-600 hover:bg-emerald-50 hover:text-slate-900'
              }`
            }
          >
            <span className="flex size-10 flex-none items-center justify-center">{item.icon}</span>
            <span className="rail-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  </div>
);
