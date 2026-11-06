import type { CommentsSeen } from '@dhd/core';

/**
 * Who this browser is when it comments: a random author key (proves which messages are its
 * own, so it may delete them) and the name it typed once. Kept in localStorage; with storage
 * disabled, for the visit.
 */

const AUTHOR = 'dhd-comment-author';
const NAME = 'dhd-comment-name';
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage disabled: kept for this visit
  }
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** 24 random bytes as 32 base64url characters, made once per browser. */
export function authorKey(): string {
  const have = read(AUTHOR);
  if (have && /^[A-Za-z0-9_-]{32}$/.test(have)) return have;
  const key = base64url(crypto.getRandomValues(new Uint8Array(24)));
  write(AUTHOR, key);
  return key;
}

export const commentName = (): string => read(NAME) ?? '';
export const setCommentName = (name: string) => write(NAME, name.trim());

const seenKey = (projectId: string) => `dhd-comments-seen:${projectId}`;

/** When this browser last looked at a plan's comments. */
export function readSeen(projectId: string): CommentsSeen {
  const raw = read(seenKey(projectId));
  if (!raw) return { all: 0, threads: {} };
  try {
    const v = JSON.parse(raw) as Partial<CommentsSeen> | number;
    if (typeof v === 'number') return { all: v, threads: {} };
    return { all: v.all ?? 0, threads: v.threads ?? {} };
  } catch {
    return { all: 0, threads: {} };
  }
}

export function writeSeen(projectId: string, seen: CommentsSeen) {
  write(seenKey(projectId), JSON.stringify(seen));
}

const PINS = 'dhd-comment-pins';
export const pinsShownSaved = () => read(PINS) !== 'off';
export const savePinsShown = (on: boolean) => write(PINS, on ? 'on' : 'off');
