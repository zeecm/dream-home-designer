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

const CONTROL =
  'input:not([disabled]):not([type="hidden"]), [role="radio"][tabindex="0"], button:not([disabled]), textarea:not([disabled])';

/**
 * Where focus goes when the control that had it went away (an answered question, Just design
 * it, a finished run's Stop, a line's Undo): never the page. Undo's own Redo; else the first
 * control of the newest turns that have one; else the composer (the heading on a phone).
 */
export function focusAfterLoss(panel: HTMLElement, lost: { label: string }) {
  const log = panel.querySelector<HTMLElement>('.talk-log');
  if (lost.label === 'Undo' || lost.label === 'Redo') {
    const again = [...(log?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .reverse()
      .find((b) => b.textContent?.trim() === (lost.label === 'Undo' ? 'Redo' : 'Undo'));
    if (again) return focusInLog(again);
  }
  const turns = [...(log?.querySelectorAll<HTMLElement>('.talk-turn:not(.talk-you)') ?? [])];
  for (const t of turns.slice(-3).reverse()) {
    const c = t.querySelector<HTMLElement>(CONTROL);
    if (c) return focusInLog(c);
  }
  // On a phone's sheet the composer would fold the sheet and raise the keyboard: the heading.
  const to = panel.classList.contains('talk-sheet')
    ? panel.querySelector<HTMLElement>('#designer-h')
    : panel.querySelector<HTMLElement>('#talk-text');
  to?.focus({ preventScroll: true });
}

/**
 * Keeps focus in the panel: when the focused control is removed (focus falls to the page),
 * focus goes to the next one.
 */
export function keepFocus(panel: HTMLElement): () => void {
  let last: { el: HTMLElement; label: string } | null = null;
  const onIn = (e: FocusEvent) => {
    const el = e.target as HTMLElement;
    last = { el, label: el.textContent?.trim() ?? '' };
  };
  const check = () => {
    if (!last || last.el.isConnected) return;
    const a = document.activeElement;
    if (a && a !== document.body && a !== document.documentElement) return;
    const lost = last;
    last = null;
    focusAfterLoss(panel, lost);
  };
  // Focus the person moved elsewhere (the plan, the top bar, another window) is theirs: only a
  // control removed while it had focus hands it on.
  const onOut = (e: FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && panel.contains(to)) return;
    const from = e.target as Node;
    // A browser may report a removed control's loss as a focusout too: that one stays handed on.
    queueMicrotask(() => {
      if (from.isConnected && last?.el === from) last = null;
    });
  };
  const mo = new MutationObserver(() => requestAnimationFrame(check));
  panel.addEventListener('focusin', onIn);
  panel.addEventListener('focusout', onOut);
  mo.observe(panel, { childList: true, subtree: true });
  return () => {
    panel.removeEventListener('focusin', onIn);
    panel.removeEventListener('focusout', onOut);
    mo.disconnect();
  };
}

/**
 * The log at its newest: its foot, unless the newest turn is taller than the log (a question on
 * a phone at half height, a card); then that turn's top, so it reads from its start.
 */
export function toNewest(log: HTMLElement) {
  const items = log.querySelectorAll<HTMLElement>('.talk-li');
  const last = items[items.length - 1];
  const foot = log.scrollHeight - log.clientHeight;
  if (!last) {
    log.scrollTop = foot;
    return;
  }
  const top = last.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop;
  log.scrollTop = Math.max(0, Math.min(foot, top - 8));
}
