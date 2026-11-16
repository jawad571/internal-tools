import type { SVGProps } from 'react';

const paths = {
  play: <path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5Z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6" y="5" width="4.2" height="14" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.8" y="5" width="4.2" height="14" rx="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  back: (
    <>
      <path d="M4 12a8 8 0 1 0 2.6-5.9" />
      <path d="M4 4v4.5h4.5" />
    </>
  ),
  forward: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  prev: (
    <>
      <path d="M6 5v14" />
      <path d="M19 6.2v11.6a.8.8 0 0 1-1.2.7L9.6 12.7a.8.8 0 0 1 0-1.4l8.2-5.8a.8.8 0 0 1 1.2.7Z" fill="currentColor" />
    </>
  ),
  next: (
    <>
      <path d="M18 5v14" />
      <path d="M5 6.2v11.6a.8.8 0 0 0 1.2.7l8.2-5.8a.8.8 0 0 0 0-1.4L6.2 5.5A.8.8 0 0 0 5 6.2Z" fill="currentColor" />
    </>
  ),
  listen: (
    <>
      <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
      <rect x="3" y="14" width="5" height="7" rx="2" />
      <rect x="16" y="14" width="5" height="7" rx="2" />
    </>
  ),
  sources: (
    <>
      <path d="M5 4a15 15 0 0 1 15 15" />
      <path d="M5 10a9 9 0 0 1 9 9" />
      <circle cx="6" cy="18" r="1.6" fill="currentColor" />
    </>
  ),
  voice: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </>
  ),
  schedule: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8.5" r="4" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V4.8h5V7" />
      <path d="M6.5 7l1 12.2a1 1 0 0 0 1 .8h7a1 1 0 0 0 1-.8l1-12.2" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4 2.8 19.5h18.4Z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17" r=".6" fill="currentColor" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  chevronLeft: <path d="M15 5 8 12l7 7" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  retry: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  sparkle: (
    <path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z" fill="currentColor" />
  ),
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5Z" />
    </>
  ),
  podcast: (
    <>
      <circle cx="12" cy="10" r="2.2" />
      <path d="M12 14.5V21" />
      <path d="M7.5 15a6.5 6.5 0 1 1 9 0" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 24, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}

/** Skip button glyph: a circular arrow with the number of seconds inside. */
export function SkipIcon({ seconds, dir, size = 32 }: { seconds: number; dir: 'back' | 'forward'; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {dir === 'back' ? paths.back : paths.forward}
      <text x="12" y="15.3" textAnchor="middle" fontSize="7.2" fontWeight="700" fill="currentColor" stroke="none" fontFamily="Inter, system-ui, sans-serif">
        {seconds}
      </text>
    </svg>
  );
}
