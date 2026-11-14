import type { Page } from '@dhd/ai';

const pages = new WeakMap<Document, Page>();

/**
 * This tab's page, as the designer's requests watch it (`@dhd/ai` has no DOM): out of view or
 * offline, and word when that changes. None outside a browser (a unit test with no document).
 */
export function browserPage(): Page | undefined {
  if (typeof document === 'undefined') return undefined;
  const doc = document;
  let page = pages.get(doc);
  if (!page) {
    page = {
      hidden: () => doc.visibilityState === 'hidden',
      offline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
      onVisibility: (fn) => {
        doc.addEventListener('visibilitychange', fn);
        return () => doc.removeEventListener('visibilitychange', fn);
      },
      onOnline: (fn) => {
        window.addEventListener('online', fn);
        return () => window.removeEventListener('online', fn);
      },
    };
    pages.set(doc, page);
  }
  return page;
}
