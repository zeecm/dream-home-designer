/**
 * Which plans get the getting-started guide: new blank plans, until their guide is finished
 * or closed. Kept per project in this browser (a per-viewer convenience).
 */
const KEY = 'dhd:guide';

function read(): Record<string, { walked?: boolean }> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function write(all: Record<string, { walked?: boolean }>) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage off: the guide just won't come back after a reload.
  }
}

export const isGuided = (id: string) => id in read();

export function startGuide(id: string) {
  write({ ...read(), [id]: {} });
}

export function endGuide(id: string) {
  const all = read();
  delete all[id];
  write(all);
}

export const hasWalked = (id: string) => !!read()[id]?.walked;

export function markWalked(id: string) {
  const all = read();
  if (all[id]) write({ ...all, [id]: { ...all[id], walked: true } });
}
