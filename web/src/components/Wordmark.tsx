export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="16" fill="var(--accent)" />
      <g fill="none" stroke="var(--accent-ink)" strokeWidth="5" strokeLinecap="round">
        <path d="M18 40V24" />
        <path d="M27 46V18" />
        <path d="M36 40V24" />
        <path d="M45 34v-4" />
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Mark />
      <span>Newscast</span>
    </span>
  );
}
