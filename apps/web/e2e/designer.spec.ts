import {
  type Design,
  type Level,
  aliasesFor,
  defaultBrief,
  levelBounds,
  levelFingerprint,
  parseSpaceDesign,
} from '@dhd/core';
import { type Page, type Route, devices, expect, test } from '@playwright/test';
import living from '../../../packages/core/src/designer/fixtures/room-living.json' with {
  type: 'json',
};
import { answerFor, promptOf } from '../src/ai/designer/fixtures/sample';
import {
  type FixtureUsage,
  anthropicStream,
  geminiStream,
  openaiStream,
} from '../src/ai/designer/fixtures/streams';
import { waitSaved } from './helpers';

/**
 * The AI designer's conversation (spec docs/specs/ai-designer-v2.md, slice 2, PR 1), against
 * mocked providers: each design request is answered with a stream as the provider sends it,
 * built from the core's mocked answers for the sample flat. Nothing reaches a real provider:
 * their hosts are blocked, and a request no fixture answers fails the test.
 */

const KEY = 'sk-ant-test-not-a-real-key-123';
const KEYS = {
  anthropic: { key: KEY, model: 'claude-opus-5-5' },
  openai: { key: 'sk-test-not-a-real-key-456', model: 'gpt-5' },
  gemini: { key: 'AIzaTestNotARealKey789', model: 'gemini-2.5-pro' },
} as const;
type P = keyof typeof KEYS;
const HOSTS: Record<P, string> = {
  anthropic: 'https://api.anthropic.com/**',
  openai: 'https://api.openai.com/**',
  gemini: 'https://generativelanguage.googleapis.com/**',
};
/** Every request's usage: 6,000 tokens, US$0.0446 at Opus's list prices. */
const USAGE: FixtureUsage = { input: 1000, cached: 3000, output: 2000, thoughts: 500 };
const STREAM = { anthropic: anthropicStream, openai: openaiStream, gemini: geminiStream };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'retry-after',
};

interface Call {
  provider: P;
  step: string;
  body: string;
}

/**
 * Mocks the three providers. `reply` may answer a call itself (a 429, say) or return a
 * promise to wait on first (a slow room).
 */
async function mock(
  page: Page,
  opts: {
    reply?: (
      c: Call,
      n: number,
    ) => { status: number; body: string; headers?: Record<string, string> } | Promise<void> | null;
  } = {},
) {
  const calls: Call[] = [];
  const unanswered: string[] = [];
  lastUnanswered = unanswered;
  for (const p of Object.keys(HOSTS) as P[]) {
    await page.route(HOSTS[p], async (route: Route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (req.method() !== 'POST') return route.abort('blockedbyclient');
      const raw = req.postData() ?? '';
      const a = answerFor(promptOf(JSON.parse(raw)));
      if (!a) {
        unanswered.push(req.url());
        return route.abort('failed');
      }
      const call = { provider: p, step: a.step, body: raw };
      calls.push(call);
      const custom = opts.reply?.(call, calls.filter((c) => c.step === call.step).length);
      if (custom instanceof Promise) await custom;
      else if (custom) {
        return route.fulfill({
          status: custom.status,
          headers: { 'content-type': 'application/json', ...CORS, ...custom.headers },
          body: custom.body,
        });
      }
      await route
        .fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream', ...CORS },
          body: STREAM[p](a.answer, USAGE),
        })
        .catch(() => {}); // aborted by Stop meanwhile
    });
  }
  return { calls, unanswered };
}

async function setup(page: Page, provider: P | null = 'anthropic', extra?: Record<string, string>) {
  page.on('pageerror', (e) => console.log(`page error: ${e.message}\n${e.stack ?? ''}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) {
      console.log(`console error: ${m.text().slice(0, 1500)}`);
    }
  });
  // No request reaches a real provider: anything the mock doesn't answer is refused.
  for (const host of Object.values(HOSTS)) {
    await page.route(host, (route) => route.abort('blockedbyclient'));
  }
  await page.addInitScript(
    ([p, k, more]) => {
      if (p)
        window.sessionStorage.setItem('dhd-ai', JSON.stringify({ active: p, keys: { [p]: k } }));
      for (const [key, v] of Object.entries(more ?? {})) window.localStorage.setItem(key, v);
    },
    [provider, provider ? KEYS[provider] : null, extra ?? null] as const,
  );
}

async function openSample(page: Page) {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
}

const planId = (page: Page) => new URL(page.url()).searchParams.get('p') ?? '';
const panel = (page: Page) => page.getByRole('complementary', { name: 'Designer' });
const log = (page: Page) => panel(page).getByRole('list', { name: 'Conversation' });
const card = (page: Page, n: number) =>
  panel(page)
    .locator('article.talk-card')
    .filter({ has: page.getByRole('heading', { name: new RegExp(`^V${n} · `) }) });
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};
/** The plan as the server has it, once saved. */
const saved = async (page: Page) => {
  await waitSaved(page);
  return page.evaluate(async (pid) => (await fetch(`/api/projects/${pid}`)).json(), planId(page));
};

async function talk(page: Page) {
  await page.getByRole('button', { name: 'Talk to the designer' }).click();
  await expect(panel(page)).toBeVisible();
}

/** Who lives here: the Ongs, two adults, a child and an older parent. */
async function ongs(page: Page) {
  const q = panel(page).getByRole('region', { name: 'Who lives here?' });
  await q.getByRole('button', { name: 'More: Children' }).click();
  await q.getByRole('button', { name: 'More: Older parents' }).click();
  await q.getByRole('button', { name: 'Done' }).click();
}

/** Past the first meeting with "Just design it", to the scope offer. */
async function justDesign(page: Page) {
  await panel(page).getByRole('button', { name: 'Just design it' }).click();
  await expect(panel(page).getByText('Where shall we start?')).toBeVisible();
}

/** A scope button, then Go ahead on the cost card if one asks. */
async function design(page: Page, scope: RegExp) {
  await panel(page).getByRole('button', { name: scope }).click();
  const go = panel(page).getByRole('button', { name: /^Go ahead( anyway)? · about US\$/ });
  if (await go.isVisible().catch(() => false)) await go.click();
  else {
    await expect(
      go.or(panel(page).locator('.talk-card [data-accept-selected]')).first(),
    ).toBeVisible();
    if (await go.isVisible()) await go.click();
  }
}

/** Every IndexedDB store's records, as text (to look for a key). */
const dumpIdb = (page: Page) =>
  page.evaluate(async () => {
    const out: string[] = [];
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(info.name as string);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      for (const name of db.objectStoreNames) {
        const rows = await new Promise<unknown[]>((resolve) => {
          const req = db.transaction(name, 'readonly').objectStore(name).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve([]);
        });
        out.push(`${info.name}/${name}: ${JSON.stringify(rows)}`);
      }
      db.close();
    }
    return out.join('\n');
  });

/** What the latest mock couldn't answer: checked after every test. */
let lastUnanswered: string[] = [];
test.beforeEach(() => {
  lastUnanswered = [];
});
test.afterEach(() => {
  expect(lastUnanswered, 'requests no fixture answers').toEqual([]);
});

test.describe('desktop', () => {
  test('the first meeting: a greeting from the plan, free questions, who sleeps where first (20, 21, 22)', async ({
    page,
  }) => {
    await setup(page);
    const m = await mock(page);
    await openSample(page);
    await talk(page);
    // 20: from the plan, with no flat type recorded; the first question with its widget.
    await expect(log(page)).toContainText(
      'I’ve looked at your plan: a flat of about 67 m², with two bedrooms, two bathrooms and the dry kitchen open to the living and dining.',
    );
    await expect(panel(page).getByRole('heading', { name: 'Designer', level: 2 })).toBeFocused();
    await shot(page, 'first-meeting');
    await ongs(page);
    await expect(log(page)).toContainText('Two adults, one child and one older parent');
    // 21: four people and two bedrooms, nobody placed: who sleeps where, before anything else.
    const sleep = panel(page).getByRole('region', { name: 'Who sleeps where?' });
    await expect(log(page)).toContainText(
      'Four people and two bedrooms, so this needs a decision.',
    );
    await expect(sleep.getByRole('group', { name: 'Main bedroom' })).toBeVisible();
    await expect(sleep.getByRole('group', { name: 'Bedroom', exact: true })).toBeVisible();
    await expect(sleep.getByRole('button', { name: 'Child 1' })).toHaveCount(2);
    await expect(panel(page).getByRole('button', { name: 'Skip' })).toHaveCount(0);
    // A tap moves one person; Done keeps the rest of the guess.
    await sleep
      .getByRole('group', { name: 'Bedroom', exact: true })
      .getByRole('button', { name: 'Child 1' })
      .click();
    await sleep.getByRole('button', { name: 'Done' }).click();
    await expect(log(page)).toContainText(
      'Adult 1 and Adult 2 in Main bedroom; Elder 1 and Child 1 in Bedroom',
    );
    await panel(page)
      .getByRole('region', { name: /How does Elder 1 get about/ })
      .getByRole('radio', { name: 'Uses a stick' })
      .click();
    await shot(page, 'questions');
    // 22: Just design it: the assumptions said, and marked in What I know.
    await justDesign(page);
    await expect(log(page)).toContainText('Fine, I’ll start. I’ve assumed:');
    await expect(log(page)).toContainText('Walls: only ones HDB normally allows.');
    await panel(page).getByRole('button', { name: 'Designer menu' }).click();
    await page.getByRole('menuitem', { name: 'What I know about you' }).click();
    const know = panel(page).getByRole('region', { name: 'What I know about you' });
    await expect(know.locator('[data-fact="walls"]')).toContainText('Walls HDB normally allows');
    await expect(know.locator('[data-fact="walls"]')).toContainText('Assumed.');
    await expect(know.locator('[data-fact="sleeping"]')).not.toContainText('Assumed.');
    // Changing a fact is free and says what changed.
    await know.locator('[data-fact="budget"]').getByRole('button', { name: 'Change' }).click();
    await know.getByRole('radio', { name: 'S$30–50k' }).click();
    await expect(know.locator('[data-fact="budget"]')).toContainText('S$30–50k');
    await know.getByRole('button', { name: '‹ Conversation' }).click();
    await expect(log(page)).toContainText('You changed: budget Not sure → S$30–50k.');
    await expect(
      panel(page).getByRole('button', { name: /^Living and dining · about US\$0\.\d\d$/ }),
    ).toBeVisible();
    await shot(page, 'scope-offer');
    // Nothing so far asked a provider for anything.
    expect(m.calls).toHaveLength(0);
  });

  test('a scope button: the cost card, ghosts while placed, Why, 2 of 5 accepted as one step, Undo exact (23, 26, 29, 31)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const m = await mock(page, { reply: () => held });
    await openSample(page);
    const before = await saved(page);
    await talk(page);
    await justDesign(page);
    // The tab's first design run: the cost card asks, with v1's cost check in it.
    await panel(page)
      .getByRole('textbox', { name: 'Message the designer' })
      .fill('More storage, please');
    await panel(page)
      .getByRole('button', { name: /^Living and dining · about US\$/ })
      .click();
    await expect(log(page)).toContainText('More storage, please');
    await expect(log(page)).toContainText(
      /Designing Living and dining takes about US\$0\.\d\d \(at most US\$\d\.\d\d, up to 3 fix-ups included\)\. Go ahead\?/,
    );
    await shot(page, 'cost-card');
    expect(m.calls).toHaveLength(0);
    await panel(page)
      .getByRole('button', { name: /^Go ahead · about US\$/ })
      .click();
    // While it is placed: progress in the card, and Accept waits for the checks.
    const v1 = card(page, 1);
    await expect(v1.getByText('Living and dining · Placing…')).toBeVisible();
    await expect(v1.getByRole('button', { name: /^Accept selected/ })).toBeDisabled();
    await expect(v1.getByText('Accept waits for the checks')).toBeVisible();
    expect(m.calls[0]?.body).toContain('More storage, please');
    release();
    await expect(v1.getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="proposal-layer"] .pv-new').first()).toBeVisible();
    await expect(page.getByText('Previewing V1, not in your plan yet')).toBeVisible();
    await expect(panel(page).getByRole('region', { name: 'On the table' })).toContainText(
      /On the table: V1 · /,
    );
    await shot(page, 'proposal');
    // 29: each card's cost and the header's sum, at the price table.
    await expect(
      v1.getByRole('button', { name: 'Cost of this reply: US$0.04, details' }),
    ).toBeVisible();
    await expect(
      panel(page).getByRole('button', {
        name: /^This conversation US\$0\.04 · this tab US\$0\.04 of US\$5\.00$/,
      }),
    ).toBeVisible();
    // 26: Why, from what was stored, with no request.
    const rows = v1
      .getByRole('group', { name: 'Living and dining' })
      .or(v1.getByRole('region', { name: 'Living and dining' }));
    const sofa = v1.getByRole('button', { name: /^Why: Add a 3.seat sofa/ });
    await sofa.click();
    await expect(
      v1.getByText('Low enough to sit under the window, facing the feature wall.'),
    ).toBeVisible();
    expect(m.calls).toHaveLength(1);
    // 23: untick the room, then tick two rows: only those two go in, as one undo step.
    const group = v1.getByRole('checkbox', { name: 'Accept all of Living and dining' });
    await group.uncheck();
    const ticks = rows.getByRole('checkbox', { name: /^Accept: / });
    const names = await ticks.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(names.length).toBeGreaterThanOrEqual(5);
    await ticks.nth(0).check();
    await ticks.nth(3).check();
    await expect(group).toHaveAttribute('aria-checked', 'mixed');
    await expect(v1.getByText(`2 of ${names.length} ticked`)).toBeVisible();
    await v1.getByRole('button', { name: 'Accept selected (2)' }).click();
    const line = log(page).getByText(`You accepted 2 of ${names.length} changes from V1.`);
    await expect(line).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Undo' }).first()).toBeFocused();
    await expect(v1.getByText(`2 of ${names.length} changes in your renovation`)).toBeVisible();
    await shot(page, 'accepted');
    const after = await saved(page);
    const items = Object.keys(after.renovation.levels[0].items);
    expect(items).toHaveLength(
      2 + (names[0]?.includes('with') ? 4 : 0) + (names[3]?.includes('with') ? 4 : 0),
    );
    // The event's Undo puts the project back exactly.
    await panel(page).getByRole('button', { name: 'Undo' }).first().click();
    await expect(
      log(page).getByText(/^Undone: the 2 changes from V1 are out of your renovation\.$/),
    ).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Redo' })).toBeVisible();
    const back = await saved(page);
    expect(back.levels).toEqual(before.levels);
    expect(back.renovation).toBeUndefined();
    // A version was made by the accept, numbered as the proposal.
    expect(m.calls).toHaveLength(1);
  });

  test('the whole flat: Stop mid-run keeps the rooms done; Design … too asks for the rest (31)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    const held: (() => void)[] = [];
    const m = await mock(page, {
      reply: (c, n) =>
        /Kitchen/.test(c.step) && n === 1 ? new Promise<void>((r) => held.push(r)) : null,
    });
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await design(page, /^The whole flat · about US\$/);
    const v1 = card(page, 1);
    await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(v1.getByText(/Placed and checked/).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, 'streaming');
    // Ghosts on the plan before Accept is offered.
    await expect(page.locator('[data-testid="proposal-layer"] .pv-ghost').first()).toBeVisible();
    await shot(page, 'streaming');
    await page.keyboard.press('Escape');
    await expect(
      v1.getByText(/^Stopped before .+ placed\. What’s here is checked\.$/),
    ).toBeVisible();
    await expect(log(page).getByText(/^Stopped\. What’s done is kept\./)).toBeVisible();
    await expect(
      v1.getByRole('button', { name: /^Design .+ too · about US\$/ }).first(),
    ).toBeVisible();
    for (const r of held) r();
    const n = m.calls.length;
    await v1.getByRole('button', { name: /^Design Kitchen too · about US\$/ }).click();
    await expect.poll(() => m.calls.length, { timeout: 30_000 }).toBeGreaterThan(n);
    await expect(v1.getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    await expect(v1.getByText(/^Stopped before/)).toHaveCount(0);
    expect(m.calls.slice(n).map((c) => c.step)).toEqual(['furnish "Kitchen"']);
  });

  test('the cost card’s Just Living and dining sends only that room; Not now sends nothing (30)', async ({
    page,
  }) => {
    await setup(page);
    const m = await mock(page);
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await panel(page)
      .getByRole('button', { name: /^The whole flat · about US\$/ })
      .click();
    await panel(page).getByRole('button', { name: 'Not now' }).click();
    await expect(log(page).getByText('Not now', { exact: true })).toBeVisible();
    expect(m.calls).toHaveLength(0);
    await panel(page)
      .getByRole('button', { name: /^The whole flat · about US\$/ })
      .click();
    await panel(page)
      .getByRole('button', { name: /^Just Living and dining · about US\$/ })
      .click();
    await expect(card(page, 1).getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    expect(m.calls.map((c) => c.step)).toEqual(['furnish "Living']);
    await expect(card(page, 1)).toContainText('V1 · Living and dining');
  });

  test('a limit of US$0.03: the card says so, the run pauses at it, Stop here keeps it', async ({
    page,
  }) => {
    await setup(page, 'anthropic', { 'dhd-ai-cap': '0.03' });
    const m = await mock(page);
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await panel(page)
      .getByRole('button', { name: /^The whole flat · about US\$/ })
      .click();
    await expect(panel(page)).toContainText('This would pass your US$0.03 limit for this tab.');
    await panel(page)
      .getByRole('button', { name: /^Go ahead anyway · about US\$/ })
      .click();
    const pause = panel(page).locator('.talk-limit');
    await expect(pause).toContainText('You’ve reached your limit for this tab.', {
      timeout: 30_000,
    });
    await pause.getByRole('button', { name: 'Stop here, keep what’s done' }).click();
    await expect(card(page, 1).getByText(/^Stopped before /)).toBeVisible();
    expect(m.calls).toHaveLength(1);
  });

  test('a 429 with retry-after 1 s: waits, then the room goes through', async ({ page }) => {
    await setup(page);
    await mock(page, {
      reply: (c, n) =>
        /Kitchen/.test(c.step) && n === 1
          ? {
              status: 429,
              headers: { 'retry-after': '1' },
              body: JSON.stringify({
                type: 'error',
                error: { type: 'rate_limit_error', message: 'Slow down' },
              }),
            }
          : null,
    });
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await design(page, /^Kitchen · about US\$/);
    await expect(card(page, 1).getByText(/Busy; trying again in 1 s \(1 of 2\)/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(card(page, 1).getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
  });

  test('v1’s versions are Earlier designs: shown on the plan and accepted change by change (33)', async ({
    page,
  }) => {
    await setup(page);
    await mock(page);
    await openSample(page);
    const doc = await saved(page);
    const level = doc.levels[0] as Level;
    const answer = parseSpaceDesign(living, levelBounds(level));
    if (!answer.ok) throw new Error(answer.error);
    const v1: Design & { schemaVersion: number } = {
      id: 'dsn_v1form',
      projectId: planId(page),
      levelId: level.id,
      n: 1,
      name: 'Calm and bright',
      parent: null,
      createdAt: '2026-11-03T08:00:00.000Z',
      base: { variant: 'before', fingerprint: levelFingerprint(level) },
      baseLevel: level,
      brief: defaultBrief(),
      request: { scope: { kind: 'all' }, feedback: '', locks: [] },
      aliases: aliasesFor(level),
      concept: null,
      spaces: {
        'rm_dry-kitchen+rm_living-and-dining': {
          name: 'Living and dining',
          status: 'done',
          design: answer.value,
        },
      },
      usage: [],
      waivers: [],
      accepted: null,
      schemaVersion: 1,
    };
    await page.evaluate(
      (rec) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('dhd-designs', 1);
          req.onupgradeneeded = () => {
            const s = req.result.createObjectStore('designs', { keyPath: ['projectId', 'id'] });
            s.createIndex('projectId', 'projectId');
            req.result.createObjectStore('briefs', { keyPath: 'projectId' });
          };
          req.onsuccess = () => {
            const tx = req.result.transaction('designs', 'readwrite');
            tx.objectStore('designs').put(rec);
            tx.oncomplete = () => {
              req.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      v1,
    );
    await page.reload();
    await waitSaved(page);
    await page.keyboard.press('1');
    await talk(page);
    await panel(page).getByRole('button', { name: 'Earlier designs (1)' }).click();
    const old = card(page, 1);
    await panel(page)
      .getByRole('button', { name: /^V1 · Calm and bright/ })
      .click();
    await old.getByRole('button', { name: 'Show V1 on the plan' }).click();
    await expect(page.getByText('Previewing V1, not in your plan yet')).toBeVisible();
    await expect(page.locator('[data-testid="proposal-layer"] .pv-new').first()).toBeVisible();
    await old.getByRole('checkbox', { name: 'Accept all of Living and dining' }).uncheck();
    await old.getByRole('checkbox', { name: /^Accept: Add a 3.seat sofa/ }).check();
    await old.getByRole('button', { name: 'Accept selected (1)' }).click();
    await expect(log(page).getByText(/^You accepted 1 of \d+ changes from V1\./)).toBeVisible();
    const after = await saved(page);
    const kinds = Object.values(
      after.renovation.levels[0].items as Record<string, { assetId: string }>,
    ).map((i) => i.assetId);
    expect(kinds).toEqual(['sofa-3']);
  });

  test('reload: the conversation, Decisions and the version are back; IndexedDB holds no key (34)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    await mock(page);
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await design(page, /^Kitchen · about US\$/);
    const v1 = card(page, 1);
    await expect(v1.getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    await v1.getByRole('button', { name: /^Accept selected/ }).click();
    await expect(log(page).getByText(/^You accepted \d+ changes from V1\.$/)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Designer menu' }).click();
    await page.getByRole('menuitem', { name: 'Decisions' }).click();
    await panel(page)
      .getByLabel('Something to keep, avoid or have')
      .fill('Keep the shoe cabinet by the door');
    await panel(page).getByRole('button', { name: 'Add' }).click();
    await expect(panel(page)).toContainText('Keep the shoe cabinet by the door');
    await waitSaved(page);
    await page.reload();
    await waitSaved(page);
    await page.keyboard.press('1');
    await page.getByRole('button', { name: /^Designer · V1 on the table$/ }).click();
    await expect(log(page)).toContainText('Fine, I’ll start. I’ve assumed:');
    await expect(card(page, 1)).toContainText('In your renovation');
    await panel(page).getByRole('button', { name: 'Designer menu' }).click();
    await page.getByRole('menuitem', { name: 'Decisions' }).click();
    await expect(panel(page)).toContainText('Keep the shoe cabinet by the door');
    const dump = await dumpIdb(page);
    expect(dump).toContain('dhd-talk/conversations');
    expect(dump).toContain('"from":{"conversationId"');
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain('not-a-real-key');
  });

  test('opening another plan mid-run asks first; Stop and open keeps the rooms done', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    const held: (() => void)[] = [];
    await mock(page, {
      reply: (c) => (c.step === 'layout' ? null : new Promise<void>((r) => held.push(r))),
    });
    await openSample(page);
    const first = planId(page);
    await talk(page);
    await justDesign(page);
    await design(page, /^The whole flat · about US\$/);
    await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThan(0);
    const open = async () => {
      await page.getByRole('button', { name: 'Projects' }).click();
      await page.getByRole('button', { name: 'New copy of the sample flat' }).click();
    };
    await open();
    const ask = page.getByRole('dialog', { name: 'Stop designing and open the other plan?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Keep designing' }).click();
    expect(planId(page)).toBe(first);
    await open();
    await ask.getByRole('button', { name: 'Stop and open' }).click();
    await waitSaved(page);
    await expect.poll(() => planId(page)).not.toBe(first);
    for (const r of held) r();
  });

  for (const provider of ['openai', 'gemini'] as const) {
    test(`${provider}: a room designed, its usage read from the final chunks`, async ({ page }) => {
      await setup(page, provider);
      const m = await mock(page);
      await openSample(page);
      await talk(page);
      await justDesign(page);
      await design(page, /^Bedroom · about US\$/);
      await expect(card(page, 1).getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
        timeout: 30_000,
      });
      expect(m.calls.every((c) => c.provider === provider)).toBe(true);
      await card(page, 1)
        .getByRole('button', { name: /^Cost of this reply/ })
        .click();
      await expect(card(page, 1).locator('.talk-cost-pop')).toContainText('3,000 from cache');
    });
  }

  test('no key: the free first meeting still runs; the scope offer asks for the key', async ({
    page,
  }) => {
    await setup(page, null);
    await openSample(page);
    await talk(page);
    const settings = page.getByRole('dialog', { name: 'AI assistant' });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Close' }).click();
    await justDesign(page);
    await expect(panel(page)).toContainText('Add your AI key to start designing');
  });

  test('a view-only link has no designer', async ({ page, browser }) => {
    await setup(page);
    await openSample(page);
    await expect(page.getByRole('button', { name: 'Talk to the designer' })).toBeVisible();
    await page.getByRole('button', { name: 'Share' }).click();
    const viewLink = await page.getByLabel('View-only link').inputValue();
    const viewer = await (await browser.newContext()).newPage();
    await viewer.goto(viewLink);
    await expect(viewer.getByText('View only.')).toBeVisible();
    await viewer.keyboard.press('1');
    await expect(viewer.getByRole('heading', { name: 'Renovation' })).toBeVisible();
    await expect(
      viewer.getByRole('button', { name: /Talk to the designer|^Designer/ }),
    ).toHaveCount(0);
  });
});

test.describe('phone, 390 px, fingers only (35)', () => {
  const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];
  test.use({ ...iPhone, viewport: { width: 390, height: 844 } });

  const noSideways = async (page: Page) =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  /** Every visible control in the panel is at least 44 px tall. */
  const fingerSized = async (page: Page) => {
    const small = await panel(page)
      .locator('button:visible, input[type="checkbox"]:visible')
      .evaluateAll((els) =>
        els
          .filter((e) => !e.classList.contains('visually-hidden'))
          .map((e) => {
            const target = e.tagName === 'INPUT' ? (e.closest('label') ?? e) : e;
            const r = target.getBoundingClientRect();
            return {
              name: e.getAttribute('aria-label') ?? e.textContent?.trim() ?? '',
              h: r.height,
            };
          })
          .filter((x) => x.h > 0 && x.h < 44),
      );
    expect(small).toEqual([]);
  };

  test('first meeting, a proposal, accept part, Undo, the sheet’s three heights', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    await mock(page);
    await page.goto('/');
    await waitSaved(page);
    await page
      .getByRole('button', { name: /Plan details|Show plan details/ })
      .first()
      .tap()
      .catch(() => {});
    await page.getByRole('button', { name: 'Talk to the designer' }).tap();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveClass(/talk-half/);
    await shot(page, 'phone-first');
    await noSideways(page);
    await fingerSized(page);
    // Who lives here, by taps.
    const q = panel(page).getByRole('region', { name: 'Who lives here?' });
    await q.getByRole('button', { name: 'More: Children' }).tap();
    await q.getByRole('button', { name: 'Done' }).tap();
    await panel(page).getByRole('button', { name: 'Just design it' }).tap();
    await panel(page)
      .getByRole('button', { name: /^Living and dining · about US\$/ })
      .tap();
    await panel(page)
      .getByRole('button', { name: /^Go ahead · about US\$/ })
      .tap();
    const v1 = card(page, 1);
    await expect(v1.getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    // The tools at the foot give way to the sheet; the plan above shows the proposal.
    await expect(page.locator('.palette')).toBeHidden();
    await shot(page, 'phone-proposal');
    // Full height, then fold to peek, each by its handle.
    await panel(page).getByRole('button', { name: 'Make the designer full height' }).tap();
    await expect(panel(page)).toHaveClass(/talk-full/);
    await expect(page.locator('.reno-bar.designer-bar')).toBeHidden();
    await fingerSized(page);
    await noSideways(page);
    await shot(page, 'phone-full');
    // Part of it: the room's tick off, one row on.
    await v1.getByRole('checkbox', { name: 'Accept all of Living and dining' }).tap();
    await v1.getByRole('checkbox', { name: /^Accept: Add a 3.seat sofa/ }).tap();
    await v1.getByRole('button', { name: 'Accept selected (1)' }).tap();
    await expect(log(page).getByText(/^You accepted 1 of \d+ changes from V1\./)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Undo' }).first().tap();
    await expect(log(page).getByText(/^Undone: /)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Make the designer smaller' }).tap();
    await expect(panel(page)).toHaveClass(/talk-half/);
    await panel(page).getByRole('button', { name: 'Fold the designer' }).dispatchEvent('click');
    await expect(panel(page)).toHaveClass(/talk-peek/);
    await shot(page, 'phone-peek');
    await noSideways(page);
  });
});
