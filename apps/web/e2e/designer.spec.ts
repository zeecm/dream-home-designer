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
import {
  REPLY_CONCERN,
  REPLY_PLAN,
  REPLY_QUESTION,
  REPLY_REJECT,
  REPLY_TEXT,
} from '../../../packages/core/src/designer/talk/fixtures/replies';
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
/** A talk call's task, as its request says it. */
const TALK_TASK = "Answer the household's message above as their designer";

async function mock(
  page: Page,
  opts: {
    reply?: (
      c: Call,
      n: number,
    ) => { status: number; body: string; headers?: Record<string, string> } | Promise<void> | null;
    /** The designer's replies to messages, in turn (a talk call with none left fails). */
    talk?: unknown[];
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
      const text = promptOf(JSON.parse(raw));
      const said = text.includes(TALK_TASK) ? opts.talk?.shift() : undefined;
      const a = text.includes(TALK_TASK)
        ? said === undefined
          ? null
          : { step: 'talk', answer: said }
        : answerFor(text);
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
    await expect(sleep.getByRole('button', { name: 'Child' })).toHaveCount(2);
    await expect(panel(page).getByRole('button', { name: 'Skip' })).toHaveCount(0);
    // The guess places everyone (no red line before anything is tapped); a tap moves one person.
    await expect(sleep.locator('.negative')).toHaveCount(0);
    await sleep
      .getByRole('group', { name: 'Main bedroom' })
      .getByRole('button', { name: 'Child' })
      .click();
    await sleep
      .getByRole('group', { name: 'Bedroom', exact: true })
      .getByRole('button', { name: 'Child' })
      .click();
    // Answered top to bottom: who sleeps where, then how the parent gets about (the order that
    // once wiped the first answer).
    await sleep.getByRole('button', { name: 'Done' }).click();
    await expect(log(page)).toContainText(
      'You and Partner in Main bedroom; Parent and Child in Bedroom',
    );
    await panel(page)
      .getByRole('region', { name: 'How does your parent get about?' })
      .getByRole('radio', { name: 'Uses a stick' })
      .click();
    await expect(log(page)).toContainText(
      'You and Partner in Main bedroom; Parent and Child in Bedroom',
    );
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
    await shot(page, 'scope-offer');
    // Nothing so far asked a provider for anything.
    expect(m.calls).toHaveLength(0);
    // The priced buttons work: no "answer who sleeps where first" left behind.
    await expect(panel(page).getByText('Answer who sleeps where first.')).toHaveCount(0);
    await design(page, /^Living and dining · about US\$0\.\d\d$/);
    await expect(card(page, 1).getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    expect(m.calls.map((c) => c.step)).toEqual(['furnish "Living']);
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
      /Designing Living and dining takes about US\$0\.\d\d \(at most US\$\d\.\d\d, up to \d fix-ups? included\)\. Go ahead\?/,
    );
    // N2: focus stays in the conversation (never the page; never on a priced button).
    const inTalk = () =>
      page.evaluate(() => {
        const a = document.activeElement;
        return a?.closest('.talk') && !a.hasAttribute('data-spends')
          ? 'in the conversation'
          : `${a?.tagName} ${a?.className} ${a?.textContent?.slice(0, 40)}`;
      });
    await expect.poll(inTalk).toBe('in the conversation');
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
    await panel(page).getByRole('button', { name: 'Stop' }).focus();
    release();
    await expect(v1.getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    // The run's Stop went away with focus on it: focus stays in the conversation (N2).
    await expect.poll(inTalk).toBe('in the conversation');
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
    // What was left out stays out: nothing is ticked again.
    await expect(v1.getByRole('button', { name: 'Accept selected (0)' })).toBeDisabled();
    await expect(panel(page).getByRole('region', { name: 'On the table' })).toContainText(
      `V1 · 2 of ${names.length} in your renovation`,
    );
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
    // Focus goes to the line's Redo, never to the page.
    await expect(panel(page).getByRole('button', { name: 'Redo' })).toBeFocused();
    // N5: what was accepted is ticked again, ready to accept again.
    await expect(v1.getByText(`2 of ${names.length} ticked`)).toBeVisible();
    const back = await saved(page);
    expect(back.levels).toEqual(before.levels);
    expect(back.renovation).toBeUndefined();
    expect(m.calls).toHaveLength(1);
    // Cheaper is a priced Another idea: a new proposal for the same room, with those words.
    await panel(page)
      .getByRole('button', { name: /^Cheaper · about US\$\d\.\d\d$/ })
      .click();
    await expect(card(page, 2).getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1]?.body).toContain('Cheaper.');
    // Why this layout? opens every stored reason, free.
    await panel(page).getByRole('button', { name: 'Why this layout?' }).click();
    await expect(card(page, 2).locator('.talk-reason').first()).toBeVisible();
    expect(m.calls).toHaveLength(2);
  });

  test('a run whose every request fails says so: nothing designed, nothing billed, Try again', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    const m = await mock(page, {
      reply: () => ({
        status: 500,
        body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Down' } }),
      }),
    });
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await design(page, /^Kitchen · about US\$/);
    const v1 = card(page, 1);
    await expect(
      v1.getByText(/The provider had a problem; trying again in \d+ s \(1 of 1\)/),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(v1.getByText(/Nothing was designed\.$/)).toBeVisible({ timeout: 40_000 });
    await expect(v1.getByText('Nothing was billed for it.')).toBeVisible();
    await expect(v1.getByRole('button', { name: /^Try again · about US\$/ })).toBeVisible();
    // Never a passing card with nothing in it, nor anything offered for it (N3).
    await expect(v1.getByText('Passes all checks')).toHaveCount(0);
    await expect(v1.getByRole('button', { name: /^Accept selected/ })).toHaveCount(0);
    await expect(v1.getByRole('button', { name: 'Show in 3D' })).toHaveCount(0);
    await expect(v1.getByRole('button', { name: /^Another idea/ })).toHaveCount(0);
    await expect(v1.getByRole('button', { name: /on the plan$/ })).toHaveCount(0);
    await expect(page.getByText('Previewing V1, not in your plan yet')).toHaveCount(0);
    // A server's trouble is said politely, not as an alert.
    await expect(v1.locator('.talk-failed[role="alert"]')).toHaveCount(0);
    await expect(panel(page).getByRole('region', { name: 'On the table' })).toContainText(
      'Didn’t finish',
    );
    expect(m.calls.length).toBeGreaterThan(0);
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
    // Its price is the kitchen's, not the whole flat's.
    const too = await v1
      .getByRole('button', { name: /^Design Kitchen too · about US\$/ })
      .innerText();
    const flat = await panel(page)
      .getByRole('button', { name: /^The whole flat · about US\$/ })
      .innerText();
    const price = (t: string) => Number(/US\$(\d+\.\d\d)/.exec(t)?.[1] ?? 'NaN');
    expect(price(too)).toBeLessThan(price(flat) / 2);
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

  test('the next room after a part or full accept: only that room, on the plan (QA B4, B8)', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await setup(page);
    await mock(page);
    await openSample(page);
    await talk(page);
    await panel(page).getByRole('button', { name: 'Just design it' }).click();
    await expect(panel(page).getByText('Where shall we start?')).toBeVisible();
    // B8: the answered control went; focus went to the next one, not the page.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('.talk') !== null))
      .toBe(true);
    await design(page, /^Living and dining · about US\$/);
    const v1 = card(page, 1);
    await expect(v1.getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    // Part: the room unticked, one piece ticked.
    await v1.getByRole('checkbox', { name: 'Accept all of Living and dining' }).uncheck();
    await v1
      .getByRole('checkbox', { name: /^Accept: / })
      .first()
      .check();
    await v1.getByRole('button', { name: 'Accept selected (1)' }).click();
    await expect(log(page).getByText(/^You accepted 1 of \d+ changes from V1\./)).toBeVisible();
    // The kitchen next: none of the living room comes back, left out or accepted.
    await design(page, /^Kitchen · about US\$/);
    const v2 = card(page, 2);
    await expect(v2.getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    await expect(v2.getByRole('checkbox', { name: 'Accept all of Living and dining' })).toHaveCount(
      0,
    );
    await expect(v2.getByRole('checkbox', { name: /^Accept: .*sofa/i })).toHaveCount(0);
    // And it is on the plan, its toggle pressed while it is.
    await expect(page.getByText('Previewing V2, not in your plan yet')).toBeVisible();
    await expect(v2.getByRole('button', { name: 'Show V2 on the plan' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await shot(page, 'v2-kitchen-only');
    // Full: everything of V2 in; the next room proposes neither room again.
    await v2.getByRole('button', { name: /^Accept selected \(\d+\)$/ }).click();
    await expect(log(page).getByText(/^You accepted \d+ changes from V2\.$/)).toBeVisible();
    const before = Object.keys((await saved(page)).renovation.levels[0].items).sort();
    await design(page, /^(Main|Master) bedroom · about US\$/);
    const v3 = card(page, 3);
    await expect(v3.getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    await expect(v3.getByRole('checkbox', { name: 'Accept all of Kitchen' })).toHaveCount(0);
    await expect(v3.getByRole('checkbox', { name: 'Accept all of Living and dining' })).toHaveCount(
      0,
    );
    await expect(page.getByText('Previewing V3, not in your plan yet')).toBeVisible();
    // Accepting V3 keeps every piece already in, with its id.
    await v3.getByRole('button', { name: /^Accept selected \(\d+\)$/ }).click();
    await expect(log(page).getByText(/^You accepted \d+ changes from V3\.$/)).toBeVisible();
    const after = Object.keys((await saved(page)).renovation.levels[0].items);
    for (const id of before) expect(after).toContain(id);
    // What was left out of V1 is remembered in Decisions.
    await panel(page).getByRole('button', { name: 'Designer menu' }).click();
    await page.getByRole('menuitem', { name: 'Decisions' }).click();
    await expect(panel(page).getByText(/^Left out of V1: /)).toBeVisible();
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

  test('dragging a piece with the designer open and a card: under 5 ms a frame of designer work', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    await mock(page);
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await design(page, /^Living and dining · about US\$/);
    const v1 = card(page, 1);
    await expect(v1.getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    await v1.getByRole('button', { name: /^Accept selected/ }).click();
    await expect(log(page).getByText(/^You accepted \d+ changes from V1\.$/)).toBeVisible();
    // The accepted sofa, dragged across the plan in 30 steps.
    const sofa = page.locator('[data-hit^="item:"]').first();
    const box = await sofa.boundingBox();
    if (!box) throw new Error('no piece to drag');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      (window as unknown as { __dhdDesignerPerf: unknown }).__dhdDesignerPerf = { ms: 0, calls: 0 };
    });
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    const frames = 30;
    for (let i = 1; i <= frames; i++) await page.mouse.move(x + i * 2, y + i);
    const perf = await page.evaluate(
      () =>
        (window as unknown as { __dhdDesignerPerf: { ms: number; calls: number } })
          .__dhdDesignerPerf,
    );
    await page.mouse.up();
    expect(perf.ms / frames).toBeLessThan(5);
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

/** Sends a message with Send (its price on it). */
async function send(page: Page, text: string) {
  await panel(page).getByRole('textbox', { name: 'Message the designer' }).fill(text);
  await panel(page)
    .getByRole('button', { name: /^Send · about US\$\d\.\d\d$/ })
    .click();
}

/**
 * Talk calls held open by the test (criterion 31): a fetch wrapper, for the test only, gives
 * the app a stream the test feeds a piece at a time (route.fulfill can't stream a body).
 */
async function holdTalk(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __talk: { held: boolean; aborted: boolean; started: number };
      __feed?: (t: string) => void;
      __end?: () => void;
    };
    w.__talk = { held: false, aborted: false, started: 0 };
    const orig = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? init.body : '';
      if (
        w.__talk.held &&
        url.startsWith('https://api.anthropic.com/') &&
        body.includes("Answer the household's message above")
      ) {
        const enc = new TextEncoder();
        w.__talk.started++;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            w.__feed = (t) => c.enqueue(enc.encode(t));
            w.__end = () => c.close();
            init?.signal?.addEventListener('abort', () => {
              w.__talk.aborted = true;
              c.error(new DOMException('The operation was aborted.', 'AbortError'));
            });
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return orig(input, init);
    };
  });
}
/** Feeds the held reply, once its request has gone. */
async function feed(page: Page, text: string) {
  await page.waitForFunction(
    () => typeof (window as unknown as { __feed?: unknown }).__feed === 'function',
  );
  await page.evaluate(
    (t) => (window as unknown as { __feed: (x: string) => void }).__feed(t),
    text,
  );
}
const endFeed = (page: Page) =>
  page.evaluate(() => (window as unknown as { __end: () => void }).__end());
/** A reply's stream, cut in the middle of its words. */
function halves(answer: unknown): [string, string] {
  const text = anthropicStream(answer, USAGE);
  const at = text.indexOf('text_delta');
  const second = text.indexOf('text_delta', at + 10);
  const cut = text.indexOf('\n\n', second) + 2;
  return [text.slice(0, cut), text.slice(cut)];
}

test.describe('talking to the designer (slice 2, PR 2)', () => {
  test('Send streams the reply; its cost shows, and the header is the sum (29, 31)', async ({
    page,
  }) => {
    await setup(page);
    await holdTalk(page);
    await mock(page);
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await page.evaluate(() => {
      (window as unknown as { __talk: { held: boolean } }).__talk.held = true;
    });
    // 29: Send shows its estimate; the hint, the guarantee.
    await expect(panel(page).getByText('Asks before anything over US$0.25')).toBeVisible();
    await send(page, 'Is a 2.4 m sofa too big for the living room?');
    await expect(log(page)).toContainText('Is a 2.4 m sofa too big for the living room?');
    await expect(panel(page).locator('.talk-streaming')).toContainText('Thinking…');
    await expect(panel(page).getByRole('button', { name: 'Stop' })).toBeVisible();
    const [head, rest] = halves(REPLY_TEXT);
    await feed(page, head);
    // 31: the first words show before the stream ends.
    const streaming = panel(page).locator('.talk-streaming .talk-text');
    await expect(streaming).toHaveText(/^A 2\.4 m/);
    const part = (await streaming.innerText()).trim();
    expect(REPLY_TEXT.say.startsWith(part)).toBe(true);
    expect(part.length).toBeLessThan(REPLY_TEXT.say.length);
    await shot(page, 'talk-streaming');
    await feed(page, rest);
    await endFeed(page);
    await expect(log(page).getByText(REPLY_TEXT.say)).toBeVisible();
    await expect(panel(page).locator('.talk-streaming')).toHaveCount(0);
    // Each reply shows its cost; the header is the sum of the turns.
    await expect(
      log(page).getByRole('button', { name: 'Cost of this reply: US$0.04, details' }),
    ).toBeVisible();
    await expect(
      panel(page).getByRole('button', { name: /^This conversation US\$0\.04 · this tab/ }),
    ).toBeVisible();
    await expect(panel(page).getByRole('button', { name: /^Send · about/ })).toBeVisible();
    await shot(page, 'talk-reply');
  });

  test('Stop mid-stream keeps the text, aborts the request and records a ~ cost (31)', async ({
    page,
  }) => {
    await setup(page);
    await holdTalk(page);
    await mock(page);
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await page.evaluate(() => {
      (window as unknown as { __talk: { held: boolean } }).__talk.held = true;
    });
    await send(page, 'Is a 2.4 m sofa too big?');
    const [head] = halves(REPLY_TEXT);
    await feed(page, head);
    await expect(panel(page).locator('.talk-streaming .talk-text')).toHaveText(/^A 2\.4 m/);
    await panel(page).getByRole('button', { name: 'Stop' }).click();
    await expect(log(page).getByText(/^Stopped\. The text so far is kept\./)).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { __talk: { aborted: boolean } }).__talk.aborted,
      ),
    ).toBe(true);
    await expect(log(page).getByText('Stopped · the text so far is kept')).toBeVisible();
    await expect(log(page).locator('.talk-designer .talk-text').last()).toHaveText(/^A 2\.4 m/);
    await expect(
      log(page).getByRole('button', { name: /^Cost of this reply: ~US\$/ }),
    ).toBeVisible();
    await expect(log(page).getByRole('button', { name: /^Try again · about US\$/ })).toBeVisible();
  });

  test('a rejection goes into Decisions; the next request carries it; editing or deleting it changes it (24)', async ({
    page,
  }) => {
    await setup(page);
    const m = await mock(page, { talk: [REPLY_REJECT, REPLY_TEXT, REPLY_TEXT, REPLY_TEXT] });
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await send(page, 'Not the sofa under the window, please.');
    await expect(log(page).getByText('Noted in Decisions: No sofa under the window')).toBeVisible();
    await expect(log(page).getByText('Noted in What I know: budget up to S$40k')).toBeVisible();
    await expect(log(page).getByText(/^Noted for your ID: Move the WC/)).toBeVisible();
    await send(page, 'And the kitchen?');
    await expect(log(page).getByText('And the kitchen?')).toBeVisible();
    await expect.poll(() => m.calls.length).toBe(2);
    expect(m.calls[1]?.body).toContain('No sofa under the window');
    // Edit, from the line under the reply: Decisions opens.
    await log(page)
      .locator('.talk-noted li')
      .filter({ hasText: 'Noted in Decisions' })
      .first()
      .getByRole('button', { name: 'Edit' })
      .click();
    const view = panel(page).getByRole('region', { name: 'Decisions' });
    await view.getByRole('button', { name: 'Edit' }).first().click();
    await view.getByRole('textbox', { name: 'Decision' }).fill('No sofa under any window');
    await view.getByRole('button', { name: 'Save' }).click();
    await view.getByRole('button', { name: '‹ Conversation' }).click();
    await send(page, 'What about the bedroom?');
    await expect.poll(() => m.calls.length).toBe(3);
    expect(m.calls[2]?.body).toContain('No sofa under any window');
    await panel(page).getByRole('button', { name: 'Designer menu' }).click();
    await page.getByRole('menuitem', { name: 'Decisions' }).click();
    await panel(page)
      .getByRole('region', { name: 'Decisions' })
      .getByRole('button', { name: 'Delete' })
      .first()
      .click();
    await panel(page).getByRole('button', { name: '‹ Conversation' }).click();
    await send(page, 'And now?');
    await expect.poll(() => m.calls.length).toBe(4);
    expect(m.calls[3]?.body).not.toContain('No sofa under any window');
  });

  test('a plan is priced before it runs: Just the first room sends only it; Go ahead sends the plan (30)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    const m = await mock(page, { talk: [REPLY_PLAN, REPLY_PLAN] });
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await send(page, 'Move the sofa off the window and redo the main bedroom.');
    await expect(log(page).getByText(REPLY_PLAN.say)).toBeVisible();
    await expect(log(page).getByText('You eat at the table most days')).toBeVisible();
    // The design run waits for Go ahead: priced, the tab's first run.
    await expect(log(page)).toContainText(
      /“Sofa off the window, dining by the kitchen” \(Living and dining and Main bedroom\) takes about US\$\d\.\d\d \(at most US\$\d+\.\d\d/,
    );
    expect(m.calls.map((c) => c.step)).toEqual(['talk']);
    await panel(page)
      .getByRole('button', { name: /^Just Living and dining · about US\$\d\.\d\d$/ })
      .click();
    await expect(card(page, 1).getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    expect(m.calls.map((c) => c.step)).toEqual(['talk', 'furnish "Living']);
    // The run carries the designer's plan and the household's words (the talk block).
    expect(m.calls[1]?.body).toContain('What this proposal is for');
    expect(m.calls[1]?.body).toContain('Sofa on the wall facing the TV');
    await send(page, 'Now both, please.');
    await expect(panel(page).getByRole('button', { name: /^Go ahead · about US\$/ })).toBeVisible();
    await panel(page)
      .getByRole('button', { name: /^Go ahead · about US\$/ })
      .click();
    await expect(card(page, 2).getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    expect(
      m.calls
        .slice(3)
        .map((c) => c.step)
        .sort(),
    ).toEqual(['furnish "Living', 'furnish "Main bedroom"'].sort());
  });

  test('a question back answers free from a chip; a pushback shows the app’s own line', async ({
    page,
  }) => {
    await setup(page);
    const m = await mock(page, {
      talk: [
        REPLY_QUESTION,
        {
          ...REPLY_CONCERN,
          say: 'That wall belongs to the household shelter.',
          concern: { rule: 'shelter', wall: 'W21', probe: null },
          plan: null,
        },
      ],
    });
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await send(page, 'Redo the kitchen');
    const q = log(page).getByRole('region', { name: 'How do you cook?' });
    // A fact's chips read as What I know says them.
    await q.getByRole('button', { name: 'A lot: big meals, wok' }).click();
    await expect(log(page).locator('.talk-bubble').last()).toHaveText('A lot: big meals, wok');
    expect(m.calls).toHaveLength(1);
    await panel(page).getByRole('button', { name: 'Designer menu' }).click();
    await page.getByRole('menuitem', { name: 'What I know about you' }).click();
    await expect(panel(page).getByRole('region', { name: 'What I know about you' })).toContainText(
      'A lot: big meals, wok',
    );
    await panel(page).getByRole('button', { name: '‹ Conversation' }).click();
    // A chip that isn't a fact goes into the composer (the priced Send carries it).
    await log(page)
      .getByRole('region', { name: 'Do you want a breakfast counter?' })
      .getByRole('button', { name: 'Yes' })
      .click();
    await expect(panel(page).getByRole('textbox', { name: 'Message the designer' })).toHaveValue(
      'Do you want a breakfast counter: Yes.',
    );
    expect(m.calls).toHaveLength(1);
    await send(page, 'Can we hack the wall by the bomb shelter?');
    await expect(
      log(page).getByText('HDB doesn’t allow this: household shelter walls can’t be changed.'),
    ).toBeVisible();
  });

  test('a hand move between turns is said, and the next request has it as fixed (32)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    const m = await mock(page, { talk: [REPLY_TEXT] });
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await design(page, /^Living and dining · about US\$/);
    const v1 = card(page, 1);
    await expect(v1.getByRole('button', { name: /^Accept selected/ })).toBeEnabled({
      timeout: 30_000,
    });
    await v1.getByRole('button', { name: /^Accept selected/ }).click();
    await expect(log(page).getByText(/^You accepted \d+ changes from V1\.$/)).toBeVisible();
    const piece = page.locator('[data-hit^="item:"]').first();
    const box = await piece.boundingBox();
    if (!box) throw new Error('no piece to move');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(box.x + box.width / 2 + i * 3, box.y + box.height / 2 + i * 2);
    }
    await page.mouse.up();
    await waitSaved(page);
    await send(page, 'Thanks, how does it look?');
    await expect(
      log(page).getByText(/^You moved the .+ yourself; it stays where you put it\.$/),
    ).toBeVisible();
    await expect.poll(() => m.calls.filter((c) => c.step === 'talk').length).toBe(1);
    expect(m.calls.find((c) => c.step === 'talk')?.body).toContain(
      'Changed by hand, so it stays as they put it (fixed)',
    );
  });

  test('a reply cut off by a closed tab is said after reload; Try again answers it', async ({
    page,
  }) => {
    await setup(page);
    await holdTalk(page);
    await mock(page, { talk: [REPLY_TEXT] });
    await openSample(page);
    await talk(page);
    await justDesign(page);
    await page.evaluate(() => {
      (window as unknown as { __talk: { held: boolean } }).__talk.held = true;
    });
    await send(page, 'Is the sofa too big?');
    const [head] = halves(REPLY_TEXT);
    await feed(page, head);
    await expect(panel(page).locator('.talk-streaming .talk-text')).toHaveText(/^A 2\.4 m/);
    // The phone kills the tab: what streamed was kept as it hid.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);
    await page.reload();
    await waitSaved(page);
    await page.keyboard.press('1');
    await page.getByRole('button', { name: /^Designer · \d+ messages?$/ }).click();
    await expect(
      log(page).getByText(
        /^The last reply was cut off when the tab closed\. It may have been billed/,
      ),
    ).toBeVisible();
    await expect(log(page).locator('.talk-designer .talk-text').last()).toHaveText(/^A 2\.4 m/);
    await expect(log(page).getByText(/^Not answered/)).toBeVisible();
    await log(page)
      .getByRole('button', { name: /^Try again · about US\$/ })
      .click();
    await expect(log(page).getByText(REPLY_TEXT.say)).toBeVisible();
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
