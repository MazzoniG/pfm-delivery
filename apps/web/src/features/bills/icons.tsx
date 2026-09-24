export const BillIcon = () => (
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
);

export const WarningIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    aria-hidden="true"
    className="mt-px flex-none"
  >
    <path
      d="M8 2.5 14.5 13.5h-13z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
    <path d="M8 6.5v3.2M8 11.6v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
