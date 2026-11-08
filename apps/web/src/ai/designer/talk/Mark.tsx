/**
 * The small outline marks of the conversation's app lines and rows (UX §6): a check, an undo
 * arrow, a stop square, a pencil, a dot. 14 px, in the text's colour; decorative (the words
 * beside them say it).
 */
export type MarkKind = 'check' | 'undo' | 'stop' | 'edit' | 'dot' | 'warn';

const PATHS: Record<MarkKind, string> = {
  check: 'M3 7.5l2.6 2.6L11 4.5',
  undo: 'M5 3.5L2.5 6 5 8.5M2.5 6h6a3 3 0 010 6h-2',
  stop: 'M4 4h6v6H4z',
  edit: 'M9.5 2.5l2 2-6.5 6.5H3V9z',
  dot: 'M7 6.2a.8.8 0 110 1.6.8.8 0 010-1.6z',
  warn: 'M7 2l5.5 10h-11zM7 6v3M7 10.5v.5',
};

export function Mark({ kind }: { kind: MarkKind }) {
  return (
    <svg
      className="talk-mark"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[kind]} />
    </svg>
  );
}
