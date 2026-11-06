/**
 * The part of the screen a keyboard leaves, as CSS variables on the root: `--vv-top` and
 * `--vv-height`. A phone's full-screen dialog sizes itself by them, so its foot (and its
 * buttons) sits above the keyboard rather than under it. On a phone the layout viewport
 * keeps its height when the keyboard opens; only the visual viewport shrinks.
 */
export function watchVisualViewport(
  root: { style: Pick<CSSStyleDeclaration, 'setProperty'> } = document.documentElement,
  vv: VisualViewport | null | undefined = window.visualViewport,
): () => void {
  if (!vv) return () => {};
  const update = () => {
    root.style.setProperty('--vv-top', `${Math.max(0, vv.offsetTop)}px`);
    root.style.setProperty('--vv-height', `${vv.height}px`);
  };
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
  };
}
