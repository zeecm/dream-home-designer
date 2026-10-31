/**
 * Projects this browser has opened, newest first; signed in, also the ones kept with the
 * account (adoptKept). The project menu and "Manage your plans" are built from this list.
 */
export interface RecentProject {
  id: string;
  name: string;
  openedAt: string;
  /** A copy of the sample flat: always kept, so it can't be deleted from the list. */
  sample?: boolean;
}

/**
 * Sample copies stay. Entries from before the flag (no `sample` at all) are known by the name
 * the sample comes with; newer ones always say.
 */
export const isSample = (r: RecentProject) => r.sample ?? / \(sample\)$/.test(r.name);

const KEY = 'dhd:recent';
const MAX = 100;

export function recentProjects(storage: Storage = window.localStorage): RecentProject[] {
  try {
    const raw = storage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RecentProject[]) : [];
    return Array.isArray(list) ? list.filter((p) => typeof p?.id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The sample copy that is always kept: the most recently opened one. Older copies (another
 * "New copy of the sample flat") may be deleted like any plan.
 */
export const keptSample = (list: RecentProject[]) => list.find(isSample)?.id;

/** Whether the plans list may delete this entry: anything but the kept sample. */
export const deletable = (r: RecentProject, list: RecentProject[]) => r.id !== keptSample(list);

export function rememberRecent(
  p: { id: string; name: string },
  storage: Storage = window.localStorage,
  sample = false,
): RecentProject[] {
  const earlier = recentProjects(storage);
  const was = earlier.find((r) => r.id === p.id);
  const entry: RecentProject = {
    id: p.id,
    name: p.name,
    openedAt: new Date().toISOString(),
    // Kept from earlier entries, including a sample known by its name before the flag.
    sample: sample || (was ? isSample(was) : false),
  };
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

/**
 * Adds the plans kept with an account to this browser's list (those it doesn't have yet, by
 * when they were last kept), and returns the list.
 */
export function adoptKept(
  kept: { id: string; name: string; sample: boolean; updatedAt: number }[],
  storage: Storage = window.localStorage,
): RecentProject[] {
  const here = recentProjects(storage);
  const known = new Set(here.map((r) => r.id));
  const added = kept
    .filter((k) => !known.has(k.id))
    .map((k) => ({
      id: k.id,
      name: k.name,
      openedAt: new Date(k.updatedAt).toISOString(),
      sample: k.sample,
    }));
  const list = [...here, ...added]
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
    .slice(0, MAX);
  try {
    storage.setItem(KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
  return list;
}
