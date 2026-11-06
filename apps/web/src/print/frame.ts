/**
 * Printing from a hidden frame: the frame goes once the print dialog closes ('afterprint',
 * or after a long wait where a browser never says), and the keyboard comes back to the app,
 * so its shortcuts work straight away.
 */

/** Puts the focus back in the app: on the Projects button, where printing starts. */
export function focusApp() {
  window.focus();
  const projects = document.querySelector<HTMLElement>('button[aria-label="Projects"]');
  if (projects) projects.focus();
  else (document.activeElement as HTMLElement | null)?.blur?.();
}

/** Prints the frame's page, then removes the frame and returns the focus to the app. */
export function printFrame(frameEl: HTMLIFrameElement) {
  const win = frameEl.contentWindow;
  if (!win) throw new Error('This browser can’t print from here.');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    frameEl.remove();
    focusApp();
  };
  // Some browsers print without blocking; ten minutes is plenty for the print dialog.
  const timer = setTimeout(finish, 10 * 60_000);
  win.addEventListener('afterprint', finish, { once: true });
  win.focus();
  win.print();
}
