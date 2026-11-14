import type { Usage } from '@dhd/core';
import type { Provider } from '../providers';
import type { DraftDesign } from '../run';
import { provider, start } from './flat';

/** What a whole run sent and kept, as `wholeFlat` reads it. */
export interface WholeFlatRun {
  phase: string;
  /** Each request's step, headers and body, by step. */
  requests: { step: string; headers: Record<string, string>; body: Record<string, unknown> }[];
  /** The design as last saved, and as returned. */
  saved: DraftDesign | null;
  design: DraftDesign;
}
export type WholeFlat = Record<Provider, WholeFlatRun>;

/** By step: rooms run side by side, so the order they finish in may differ. */
const byStep = <T extends { step: string }>(xs: T[]) =>
  [...xs].sort((a, b) => (a.step < b.step ? -1 : a.step > b.step ? 1 : 0));
/** Without how long each request took (the one thing that differs between two runs). */
const timeless = (u: Usage[]) => byStep(u.map((x) => ({ ...x, ms: 0 })));
const kept = (d: DraftDesign): DraftDesign => ({ ...d, usage: timeless(d.usage) });

/**
 * The sample flat designed with each provider's mocked answers, on real timers, as any
 * runtime runs it: what was sent and what was kept. A server run must equal a browser run
 * (cloud runs, tech §2), so this is compared across Node and workerd.
 */
export async function wholeFlat(): Promise<WholeFlat> {
  const out: Partial<WholeFlat> = {};
  for (const p of ['anthropic', 'openai', 'gemini'] as const) {
    const prov = provider(p, { auto: true });
    const r = start(p, { fetch: prov.fetch });
    const { state, design } = await r.run;
    const last = r.saved.at(-1);
    out[p] = {
      phase: state.phase,
      requests: byStep(prov.calls.map((c) => ({ step: c.step, headers: c.headers, body: c.body }))),
      saved: last ? kept(last) : null,
      design: kept(design),
    };
  }
  return out as WholeFlat;
}

/** JSON with every object's keys in order: the same text for equal data. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A whole flat's runs in short (each request and each design as a SHA-256 of its canonical
 * JSON), small and plain enough to hand from one runtime to another.
 */
export async function fingerprint(w: WholeFlat) {
  const out: Record<string, unknown> = {};
  for (const [p, run] of Object.entries(w)) {
    out[p] = {
      phase: run.phase,
      requests: await Promise.all(
        run.requests.map(async (r) => ({ step: r.step, sha: await sha256(canonical(r)) })),
      ),
      saved: await sha256(canonical(run.saved)),
      design: await sha256(canonical(run.design)),
    };
  }
  return out;
}
