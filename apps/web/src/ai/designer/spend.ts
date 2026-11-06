import { PRICES, type Price, type Usage } from '@dhd/core';
import { useSyncExternalStore } from 'react';

/**
 * What AI requests have cost in this tab, the soft limit on it, and the prices used: the
 * meter (`dhd-ai-spend`, sessionStorage: this tab only), the limit (`dhd-ai-cap`,
 * localStorage, US$5 unless changed) and price overrides per model (`dhd-ai-prices`,
 * localStorage). No keys are kept here, and nothing here leaves the browser.
 */

export interface Spend {
  usd: number;
  tokens: number;
  /** Runs started in this tab (the first always gets the cost check). */
  runs: number;
}

const SPEND = 'dhd-ai-spend';
const CAP = 'dhd-ai-cap';
const PRICE_KEY = 'dhd-ai-prices';
export const DEFAULT_CAP = 5;
/** The limits AI settings offers (US$); null is no limit. */
export const CAPS: (number | null)[] = [1, 2, 5, 10, 20, null];

const listeners = new Set<() => void>();
const emit = () => {
  for (const fn of listeners) fn();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

function readJson<T>(storage: () => Storage, key: string): T | null {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(storage: () => Storage, key: string, value: unknown) {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, JSON.stringify(value));
  } catch {
    // A private window may refuse: the figures hold for this visit.
  }
}
const session = () => window.sessionStorage;
const local = () => window.localStorage;

const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function loadSpend(): Spend {
  const v = readJson<Partial<Spend>>(session, SPEND);
  return { usd: finite(v?.usd), tokens: finite(v?.tokens), runs: finite(v?.runs) };
}
let spend: Spend = typeof window === 'undefined' ? { usd: 0, tokens: 0, runs: 0 } : loadSpend();

function loadCap(): number | null {
  try {
    const raw = window.localStorage.getItem(CAP);
    if (raw === null) return DEFAULT_CAP;
    if (raw === 'none') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP;
  } catch {
    return DEFAULT_CAP;
  }
}
let cap: number | null = typeof window === 'undefined' ? DEFAULT_CAP : loadCap();

function loadPrices(): Record<string, Price> {
  const v = readJson<Record<string, Partial<Price>>>(local, PRICE_KEY) ?? {};
  const out: Record<string, Price> = {};
  for (const [id, p] of Object.entries(v)) {
    if (!p || typeof p !== 'object') continue;
    out[id] = {
      input: finite(p.input),
      cachedInput: finite(p.cachedInput),
      cacheWrite: p.cacheWrite === null ? null : finite(p.cacheWrite),
      output: finite(p.output),
      checked: false,
    };
  }
  return out;
}
let overrides: Record<string, Price> = typeof window === 'undefined' ? {} : loadPrices();
let prices: Record<string, Price> = { ...PRICES, ...overrides };

/** The tab's meter as it is now. */
export const spent = (): Spend => spend;
/** The tab's limit in US$ (null: none). */
export const capUsd = (): number | null => cap;
/** The price table: list prices, with this browser's own where it has them. */
export const priceTable = (): Record<string, Price> => prices;
/** Whether the person has entered their own price for `model`. */
export const hasOverride = (model: string) => !!overrides[model.trim().toLowerCase()];

/** Adds a request's usage to the meter. */
export function addUsage(u: Usage) {
  spend = {
    ...spend,
    usd: spend.usd + (u.usd ?? 0),
    tokens: spend.tokens + u.input + u.cachedInput + u.cacheWrite + u.output,
  };
  writeJson(session, SPEND, spend);
  emit();
}

/** Counts a run started (the first in a tab always shows its cost first). */
export function countRun() {
  spend = { ...spend, runs: spend.runs + 1 };
  writeJson(session, SPEND, spend);
  emit();
}

export function resetSpend() {
  spend = { usd: 0, tokens: 0, runs: spend.runs };
  writeJson(session, SPEND, spend);
  emit();
}

export function setCap(v: number | null) {
  cap = v;
  try {
    window.localStorage.setItem(CAP, v === null ? 'none' : String(v));
  } catch {
    // kept for this visit
  }
  emit();
}

/** Sets this browser's price for `model`; null goes back to the list price. */
export function setPrice(model: string, p: Price | null) {
  const id = model.trim().toLowerCase();
  const next = { ...overrides };
  if (p) next[id] = { ...p, checked: false };
  else delete next[id];
  overrides = next;
  prices = { ...PRICES, ...overrides };
  writeJson(local, PRICE_KEY, Object.keys(next).length ? next : null);
  emit();
}

/** Whether `more` US$ would take the tab past its limit. */
export const wouldPass = (more: number) => cap !== null && spend.usd + more > cap;
/** Whether the tab has reached its limit. */
export const overLimit = () => cap !== null && spend.usd >= cap;

/** "US$0.87" under US$10, else whole dollars ("US$12"). */
export function usd(v: number): string {
  if (v < 10) return `US$${v.toFixed(2)}`;
  return `US$${Math.round(v).toLocaleString('en-US')}`;
}
/** Tokens with thousands separators. */
export const tokens = (n: number) => Math.round(n).toLocaleString('en-US');

/** Re-renders with the meter, the limit and the prices. */
export function useSpend(): { spend: Spend; cap: number | null; prices: Record<string, Price> } {
  const s = useSyncExternalStore(subscribe, () => spend);
  const c = useSyncExternalStore(subscribe, () => cap);
  const p = useSyncExternalStore(subscribe, () => prices);
  return { spend: s, cap: c, prices: p };
}

/** For tests: read storage afresh. */
export function reloadSpend() {
  spend = loadSpend();
  cap = loadCap();
  overrides = loadPrices();
  prices = { ...PRICES, ...overrides };
  emit();
}
