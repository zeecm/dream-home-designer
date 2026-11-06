import { useSyncExternalStore } from 'react';
import { shownView, useEditor } from '../editor';

/**
 * Every phone, upright or on its side: narrower than 720 px, or a touch screen under 500 px
 * tall. The same breakpoints as styles.css (the phone, and the phone on its side). These get
 * one view at a time and one button to the other view.
 */
export const ONE_VIEW_QUERY =
  '(max-width: 720px), (orientation: landscape) and (max-height: 500px) and (pointer: coarse)';

const media = () =>
  typeof window === 'undefined' ? undefined : window.matchMedia?.(ONE_VIEW_QUERY);

const subscribe = (onChange: () => void) => {
  const m = media();
  m?.addEventListener('change', onChange);
  return () => m?.removeEventListener('change', onChange);
};

/** True on a screen with room for one view at a time. */
export const useOneView = () =>
  useSyncExternalStore(
    subscribe,
    () => media()?.matches ?? false,
    () => false,
  );

/** The view the stage shows: Split, on a phone, is the last single view chosen. */
export function useShownView() {
  const oneView = useOneView();
  const mode = useEditor((s) => s.viewMode);
  const last = useEditor((s) => s.lastSingle);
  return shownView(mode, last, oneView);
}

/** The view the stage shows now, outside React. */
export function shownViewNow() {
  const { viewMode, lastSingle } = useEditor.getState();
  return shownView(viewMode, lastSingle, media()?.matches ?? false);
}
