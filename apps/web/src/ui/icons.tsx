import type { ReactNode } from 'react';

/** One outline set: 16px, 1.5px stroke, currentColor. */
function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const icons = {
  select: (
    <Icon>
      <path d="M3.5 2.5l9 5-4 1-1.5 4z" />
    </Icon>
  ),
  wall: (
    <Icon>
      <path d="M2.5 13.5v-11h11" />
      <path d="M5 13.5v-8.5h8.5" />
    </Icon>
  ),
  door: (
    <Icon>
      <path d="M2.5 13.5h3M10.5 13.5h3" />
      <path d="M5.5 13.5v-8" />
      <path d="M5.5 5.5a8 8 0 0 1 8 8" strokeDasharray="1.5 1.5" />
    </Icon>
  ),
  window: (
    <Icon>
      <rect x="2" y="6" width="12" height="4" />
      <path d="M2 8h12" />
    </Icon>
  ),
  passage: (
    <Icon>
      <path d="M1.5 8h4M10.5 8h4" />
      <path d="M5.5 5.5v5M10.5 5.5v5" />
    </Icon>
  ),
  measure: (
    <Icon>
      <path d="M2 11l9-9 3 3-9 9z" />
      <path d="M5 8l1.5 1.5M7 6l1 1M9 4l1.5 1.5" />
    </Icon>
  ),
  calibrate: (
    <Icon>
      <path d="M2 13.5h12" />
      <path d="M2 11.5v4M14 11.5v4" />
      <circle cx="8" cy="6" r="3.5" />
      <path d="M8 1.5v1.5M8 9v1.5M3.5 6H5M11 6h1.5" />
    </Icon>
  ),
  image: (
    <Icon>
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M2.5 11l3.5-3.5 3 3 2-2 3 3" />
      <circle cx="10.5" cy="5.5" r="1" />
    </Icon>
  ),
  undo: (
    <Icon>
      <path d="M5.5 3L2.5 6l3 3" />
      <path d="M2.5 6h7a4 4 0 0 1 0 8H7" />
    </Icon>
  ),
  redo: (
    <Icon>
      <path d="M10.5 3l3 3-3 3" />
      <path d="M13.5 6h-7a4 4 0 0 0 0 8H9" />
    </Icon>
  ),
  plus: (
    <Icon>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  ),
  minus: (
    <Icon>
      <path d="M3 8h10" />
    </Icon>
  ),
  fit: (
    <Icon>
      <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" />
    </Icon>
  ),
  chevronDown: (
    <Icon>
      <path d="M4 6l4 4 4-4" />
    </Icon>
  ),
  close: (
    <Icon>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  ),
  trash: (
    <Icon>
      <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9" />
    </Icon>
  ),
  split: (
    <Icon>
      <path d="M2 8h12" />
      <circle cx="8" cy="8" r="2" />
    </Icon>
  ),
};

/** The product's mark: a plan corner with a door swing, drawn in the accent. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect width="20" height="20" rx="5" fill="var(--accent)" />
      <path d="M5 15V5h10" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="square" />
      <path d="M8.5 15a6.5 6.5 0 0 1 6.5-6.5" fill="none" stroke="#fff" strokeWidth="1.2" />
      <path d="M8.5 15V8.5" fill="none" stroke="#fff" strokeWidth="1.2" />
    </svg>
  );
}
