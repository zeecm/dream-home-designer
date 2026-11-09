/**
 * The class of a dialog that floats beside its target without taking the keys (the plan's
 * popover on a computer): the app's shortcuts (undo, Delete, the arrows, the tools) still work
 * while it is open.
 */
export const FLOAT_DIALOG = 'dialog-float';

/** Whether a dialog open over the app has the keys (so shortcuts behind it stay quiet). */
export const dialogHasKeys = () =>
  typeof document !== 'undefined' && !!document.querySelector(`dialog[open]:not(.${FLOAT_DIALOG})`);
