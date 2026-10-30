/**
 * Projects this browser has opened, newest first. The public API doesn't list projects
 * (there's no auth yet), so the project menu is built from this list instead.
 */
export interface RecentProject {
  id: string;
  name: string;
  openedAt: string;
  /** A copy of the sample flat: always kept, so it can't be deleted from the list. */
  sample?: boolean;
}

/** Sample copies stay; older ones are known by the name the sample comes with. */
export const isSample = (r: RecentProject) => !!r.sample || / \(sample\)$/.test(r.name);

const KEY = 'dhd:recent';
const MAX = 20;

export function recentProjects(storage: Storage = window.localStorage): RecentProject[] {
  try {
    const raw = storage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RecentProject[]) : [];
    return Array.isArray(list) ? list.filter((p) => typeof p?.id === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberRecent(
  p: { id: string; name: string },
  storage: Storage = window.localStorage,
  sample = false,
): RecentProject[] {
  const earlier = recentProjects(storage);
  const was = earlier.find((r) => r.id === p.id);
  const entry: RecentProject = { id: p.id, name: p.name, openedAt: new Date().toISOString() };
  if (sample || was?.sample) entry.sample = true;
  const list = [entry, ...earlier.filter((r) => r.id !== p.id)].slice(0, MAX);
  try {
    storage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage full or disabled: the menu just won't remember this one.
  }
  return list;
}

export function forgetRecent(id: string, storage: Storage = window.localStorage): RecentProject[] {
  const list = recentProjects(storage).filter((r) => r.id !== id);
  try {
    storage.setItem(KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
  return list;
}
