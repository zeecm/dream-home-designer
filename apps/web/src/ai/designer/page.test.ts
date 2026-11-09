import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserPage } from './page';

describe('the browser page the designer’s requests watch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('none without a document (Node)', () => {
    expect(browserPage()).toBeUndefined();
  });

  it('reads the document and the connection, and hears them change until told to stop', () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const win = new EventTarget();
    const nav = { onLine: true };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    vi.stubGlobal('navigator', nav);
    const page = browserPage();
    if (!page) throw new Error('no page');
    // One page per document.
    expect(browserPage()).toBe(page);
    expect([page.hidden(), page.offline()]).toEqual([false, false]);
    doc.visibilityState = 'hidden';
    nav.onLine = false;
    expect([page.hidden(), page.offline()]).toEqual([true, true]);
    const heard: string[] = [];
    const stopV = page.onVisibility(() => heard.push('visibility'));
    const stopO = page.onOnline(() => heard.push('online'));
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('online'));
    stopV();
    stopO();
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('online'));
    expect(heard).toEqual(['visibility', 'online']);
  });
});
