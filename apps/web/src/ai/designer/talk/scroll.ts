/**
 * Brings `el` into view inside the conversation's log, scrolling the log alone: never the
 * panel, the sheet or the page (`scrollIntoView` moves every scrollable ancestor, which on a
 * phone scrolled the sheet's own header away).
 */
export function scrollInLog(el: Element | null | undefined, block: 'start' | 'end' | 'nearest') {
  const log = el?.closest<HTMLElement>('.talk-log, .talk-view');
  if (!el || !log) return;
  const box = el.getBoundingClientRect();
  const frame = log.getBoundingClientRect();
  const top = box.top - frame.top + log.scrollTop;
  const bottom = top + box.height;
  let to: number;
  if (block === 'start') to = top - 8;
  else if (block === 'end') to = bottom - log.clientHeight + 8;
  else if (top < log.scrollTop) to = top - 8;
  else if (bottom > log.scrollTop + log.clientHeight) to = bottom - log.clientHeight + 8;
  else return;
  log.scrollTop = Math.max(0, to);
}

/** Focuses `el` without moving anything, then shows it in the log. */
export function focusInLog(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.focus({ preventScroll: true });
  scrollInLog(el, 'nearest');
}
