import { type Page, type Route, devices, expect, test } from '@playwright/test';
import { answerFor, promptOf } from '../src/ai/designer/fixtures/sample';
import {
  type FixtureUsage,
  anthropicStream,
  geminiStream,
  openaiStream,
} from '../src/ai/designer/fixtures/streams';
import { waitSaved } from './helpers';

/**
 * The AI designer (spec criteria 29–43 that are in PR 1b), against mocked providers: each
 * request is answered with a stream as the provider sends it, built from the core's mocked
 * answers for the sample flat. Nothing reaches a real provider: their hosts are blocked, and
 * a request no fixture answers fails the test.
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

async function setup(page: Page, provider: P = 'anthropic', extra?: Record<string, string>) {
  // No request reaches a real provider: anything the mock doesn't answer is refused.
  for (const host of Object.values(HOSTS)) {
    await page.route(host, (route) => route.abort('blockedbyclient'));
  }
  await page.addInitScript(
    ([p, k, more]) => {
      window.sessionStorage.setItem('dhd-ai', JSON.stringify({ active: p, keys: { [p]: k } }));
      for (const [key, v] of Object.entries(more ?? {})) window.localStorage.setItem(key, v);
    },
    [provider, KEYS[provider], extra ?? null] as const,
  );
}

async function openSample(page: Page) {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
}

const planId = (page: Page) => new URL(page.url()).searchParams.get('p') ?? '';

/** How many designs and briefs this browser keeps for a plan (IndexedDB). */
function storedFor(page: Page, projectId: string) {
  return page.evaluate(
    (pid) =>
      new Promise<{ designs: number; briefs: number }>((resolve, reject) => {
        const req = indexedDB.open('dhd-designs');
        req.onsuccess = () => {
          const tx = req.result.transaction(['designs', 'briefs'], 'readonly');
          const d = tx.objectStore('designs').index('projectId').count(pid);
          const b = tx.objectStore('briefs').count(pid);
          tx.oncomplete = () => {
            resolve({ designs: d.result, briefs: b.result });
            req.result.close();
          };
        };
        req.onerror = () => reject(req.error);
      }),
    projectId,
  );
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Designer' });
const compare = (page: Page) => page.getByRole('region', { name: 'Compare' });
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

/** The brief, the cost check, and the run to its end. */
async function designFlat(page: Page) {
  await page.getByRole('button', { name: 'Design my flat with AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Design my flat' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Next: check the cost' }).click();
  const check = page.getByRole('dialog', { name: 'Check the cost' });
  await check.getByRole('button', { name: /^Design my flat · about US\$/ }).click();
  await expect(panel(page).getByText(/^Done in /)).toBeVisible({ timeout: 30_000 });
}

/** What the latest mock couldn't answer: checked after every test. */
let lastUnanswered: string[] = [];
test.beforeEach(() => {
  lastUnanswered = [];
});
test.afterEach(() => {
  expect(lastUnanswered, 'requests no fixture answers').toEqual([]);
});

test.describe('desktop', () => {
  test('brief, cost check, a run step by step, the preview, Left out, and Accept with Undo (29–33)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    const m = await mock(page);
    await openSample(page);

    // 29: the brief, then the cost; Cancel and Back send nothing.
    await page.getByRole('button', { name: 'Design my flat with AI' }).click();
    let dialog = page.getByRole('dialog', { name: 'Design my flat' });
    await expect(dialog.getByRole('button', { name: /Who lives here/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await dialog.getByRole('button', { name: 'Fewer: Adults' }).click();
    await dialog.getByRole('button', { name: 'More: Elderly' }).click();
    await dialog.getByLabel('Elder 1').selectOption('frame');
    await expect(dialog.getByRole('button', { name: /Who lives here/ })).toContainText(
      '1 adult · 1 elder, frame',
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Design my flat with AI' }).click();
    dialog = page.getByRole('dialog', { name: 'Design my flat' });
    // Remembered for this plan.
    await expect(dialog.getByRole('button', { name: /Who lives here/ })).toContainText(
      '1 elder, frame',
    );
    await dialog.getByRole('button', { name: 'Next: check the cost' }).click();
    const check = page.getByRole('dialog', { name: 'Check the cost' });
    await expect(
      check.getByRole('heading', { name: 'This uses a lot of AI tokens' }),
    ).toBeFocused();
    await expect(check).toContainText('5 requests to Claude (claude-opus-5-5)');
    await expect(check).toContainText(/About US\$\d+\.\d\d/);
    await expect(check).toContainText(/at most US\$\d+\.\d\d/);
    const start = check.getByRole('button', { name: /^Design my flat · about US\$/ });
    await expect(start).not.toBeFocused();
    await check.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('dialog', { name: 'Design my flat' })).toBeVisible();
    expect(m.calls).toHaveLength(0);
    await page.getByRole('button', { name: 'Next: check the cost' }).click();
    await check.getByRole('button', { name: /^Design my flat · about US\$/ }).click();

    // 30: the steps tick in order; the total rises; the done line has the fixtures' usage.
    const p = panel(page);
    await expect(p).toBeVisible();
    await expect(p.getByText(/^Done in /)).toBeVisible({ timeout: 30_000 });
    const rows = p.locator('.designer-steps .step-row');
    await expect(rows).toHaveCount(7);
    await expect(rows.nth(1)).toContainText('Layout and style');
    await expect(p.locator('.step-row-done')).toHaveCount(5);
    expect(m.calls.map((c) => c.step)[0]).toBe('layout');
    expect(m.calls).toHaveLength(5);
    // 5 × 6,000 tokens, 5 × US$0.0446 at the list price.
    await expect(p.getByText(/^Done in /)).toContainText(
      '30,000 tokens (15,000 from cache) · US$0.22',
    );
    expect(m.unanswered).toEqual([]);

    // 32: the shelter op is left out, in HDB's words.
    await p.getByText(/^Left out/).click();
    await expect(p.locator('.designer-left-out')).toContainText(
      'household shelter walls can’t be changed. HDB doesn’t allow it.',
    );

    // 31: the version is on the plan (pieces and paint), not in the project.
    await expect(page.locator('.designer-bar')).toContainText(
      'Previewing V1, not in your plan yet',
    );
    const pieces = page.locator('[data-hit^="item:"]');
    await expect.poll(() => pieces.count()).toBeGreaterThan(20);
    const id = new URL(page.url()).searchParams.get('p');
    const saved = await page.evaluate(
      async (pid) => (await fetch(`/api/projects/${pid}`)).json(),
      id,
    );
    expect(saved.renovation).toBeUndefined();
    expect(Object.keys(saved.levels[0].items)).toHaveLength(0);
    // Undo and Redo wait while a version is on show, and say why.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveAttribute(
      'title',
      'Undo isn’t available while previewing',
    );
    // Walking the version: a reminder that it isn't the plan, clear of the banner.
    await page.keyboard.press('3');
    await page.getByRole('button', { name: 'Walk through' }).click();
    const pill = page.locator('.designer-walk-pill');
    await expect(pill).toHaveText('Previewing V1, not your plan');
    const pb = await pill.boundingBox();
    const bb = await page.locator('.sample-banner').boundingBox();
    expect((pb?.y ?? 0) >= (bb?.y ?? 0) + (bb?.height ?? 0) - 1).toBe(true);
    await page.getByRole('button', { name: 'Leave walk' }).click();
    await page.keyboard.press('1');
    // Before | V1 in the bar.
    await page.locator('.designer-bar').getByRole('button', { name: 'Before' }).click();
    await expect.poll(() => pieces.count()).toBe(0);
    await page.locator('.designer-bar').getByRole('button', { name: 'V1' }).click();
    await expect.poll(() => pieces.count()).toBeGreaterThan(20);
    // The 3D view shows it too (no error).
    await page.keyboard.press('2');
    await expect(page.locator('.viewport canvas')).toBeVisible();
    await page.keyboard.press('1');
    await page.getByRole('button', { name: 'Back to my plan' }).click();
    await expect(page.locator('.designer-bar')).toHaveCount(0);
    await expect.poll(() => pieces.count()).toBe(0);

    // 33: Accept everything: After shows, one Undo restores, the toast's Undo too.
    await p.getByRole('button', { name: 'Accept…' }).click();
    const accept = page.getByRole('dialog', { name: 'Put V1 into your renovation' });
    await expect(accept.getByLabel(/Walls and doors/)).toBeChecked();
    await accept.getByRole('button', { name: /^Accept \d+ changes$/ }).click();
    await expect(accept).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('Design V1 is in your renovation.');
    await expect(page.locator('.reno-bar').getByRole('button', { name: 'After' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect.poll(() => pieces.count()).toBeGreaterThan(20);
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.reno-bar')).toHaveCount(0);
    await expect.poll(() => pieces.count()).toBe(0);
    // Again, and Ctrl+Z.
    await p.getByRole('button', { name: 'Accept…' }).click();
    await page
      .getByRole('dialog', { name: 'Put V1 into your renovation' })
      .getByRole('button', { name: /^Accept \d+ changes$/ })
      .click();
    await expect(page.locator('.reno-bar')).toBeVisible();
    await p.getByRole('button', { name: 'Close the designer' }).click();
    // The plan details: the version's wall changes and the cost estimate.
    await expect(page.getByRole('heading', { name: 'Changes, room by room' })).toBeVisible();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.reno-bar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Designs (1)' })).toBeVisible();
  });

  test('Accept only Living and dining’s furniture: only pieces there change (34)', async ({
    page,
  }) => {
    await setup(page);
    await mock(page);
    await openSample(page);
    await designFlat(page);
    await panel(page).getByRole('button', { name: 'Accept…' }).click();
    const accept = page.getByRole('dialog', { name: 'Put V1 into your renovation' });
    const ticked = accept.locator('input[type="checkbox"]:checked:not(:disabled)');
    while ((await ticked.count()) > 0) await ticked.first().uncheck();
    // Without the walls, a room the walls change can't take furniture.
    const living = accept.getByRole('group', { name: 'Living and dining' });
    const furniture = living.getByRole('checkbox', { name: /Furniture/ });
    await expect(furniture).toBeEnabled();
    await furniture.check();
    const n = Number(
      /\((\d+)\)/.exec(
        (await living.locator('label', { hasText: 'Furniture' }).textContent()) ?? '',
      )?.[1],
    );
    expect(n).toBeGreaterThan(3);
    await accept.getByRole('button', { name: `Accept ${n} changes` }).click();
    await waitSaved(page);
    const id = new URL(page.url()).searchParams.get('p');
    const saved = await page.evaluate(
      async (pid) => (await fetch(`/api/projects/${pid}`)).json(),
      id,
    );
    const after = saved.renovation.levels[0];
    expect(Object.keys(after.items)).toHaveLength(n);
    // The walls are the flat's own.
    expect(Object.keys(after.walls).sort()).toEqual(Object.keys(saved.levels[0].walls).sort());

    // Previewing a version again, Undo waits: the plan's history isn't touched out of sight.
    await panel(page).getByRole('tab', { name: /^V1/ }).click();
    await expect(page.locator('.designer-bar')).toContainText('Previewing V1');
    await page.keyboard.press('Control+z');
    await page.getByRole('button', { name: 'Back to my plan' }).click();
    await expect(page.locator('.reno-bar')).toBeVisible();
    await expect.poll(() => page.locator('[data-hit^="item:"]').count()).toBe(n);
  });

  test('Change something ▸ Kitchen, Furniture: one request with the feedback; V2; Compare (35)', async ({
    page,
  }) => {
    await setup(page);
    const m = await mock(page);
    await openSample(page);
    await designFlat(page);
    const p = panel(page);
    await p.getByRole('button', { name: 'Change something' }).click();
    await p.getByLabel('What to change').selectOption({ label: 'Kitchen' });
    await p.getByRole('button', { name: 'Built-ins' }).click();
    await p.getByRole('button', { name: 'Paint and floors' }).click();
    await expect(p.getByRole('button', { name: 'Furniture' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await p.getByLabel('What would you like different?').fill('more storage');
    await expect(p.getByText(/^1 request: Kitchen furniture/)).toBeVisible();
    const before = m.calls.length;
    // A double click starts one paid run, not two.
    await p.getByRole('button', { name: /^Make V2 · about US\$/ }).dblclick();
    await expect(p.getByRole('tab', { name: 'V2' })).toBeVisible({ timeout: 30_000 });
    await expect(p.getByText(/^Done in /)).toBeVisible({ timeout: 30_000 });
    await expect(p.getByRole('tab')).toHaveCount(2);
    const sent = m.calls.slice(before);
    expect(sent).toHaveLength(1);
    // What V2 changed, in words; no internal ids anywhere on its card.
    await expect(p.locator('.designer-changed')).toHaveText(
      'From V1. Changed: Kitchen furniture · “more storage”',
    );
    expect(await p.locator('.designer-card').innerText()).not.toMatch(/\b[WDRP]\d+\b/);
    expect(sent[0]?.body).toContain('more storage');
    expect(sent[0]?.body).toContain('furnish \\"Kitchen\\"');
    expect(sent[0]?.body).not.toContain('furnish \\"Living');
    await expect(p.getByRole('tab', { name: 'V1' })).toBeVisible();
    await expect(p.getByRole('tab', { name: 'V2' })).toHaveAttribute('aria-selected', 'true');

    // Compare: Before first, then V1 and V2, each drawn at one scale with its cost and checks.
    await p.getByRole('button', { name: 'Compare' }).click();
    const c = compare(page);
    await expect(c.getByRole('heading', { name: 'Compare' })).toBeFocused();
    await expect(c.getByRole('heading', { level: 3 })).toHaveText([
      /^Before The flat as it is$/,
      /^V1 /,
      /^V2 /,
    ]);
    const plans = c.locator('.compare-mini');
    await expect(plans).toHaveCount(3);
    const boxes = await plans.evaluateAll((els) => els.map((e) => e.getAttribute('viewBox')));
    expect(new Set(boxes).size).toBe(1);
    // Rooms tinted, pieces drawn: Before has none, the versions have them.
    await expect(plans.nth(0).locator('.mini-item')).toHaveCount(0);
    expect(await plans.nth(1).locator('.mini-item').count()).toBeGreaterThan(20);
    const v2 = c.getByRole('region', { name: /^V2 / });
    await expect(v2.locator('.compare-facts')).toContainText(/S\$\d+k–\d+k/);
    await expect(v2.locator('.compare-facts')).toContainText('Wall changes');
    await expect(v2.locator('.compare-facts')).toContainText('Problems');
    expect(await c.innerText()).not.toMatch(/\b[WDRP]\d+\b/);
    // On a computer the columns sit side by side; the phone's switch is hidden.
    const [a, b] = await Promise.all([plans.nth(0).boundingBox(), plans.nth(2).boundingBox()]);
    expect(Math.abs((a?.y ?? 0) - (b?.y ?? 1))).toBeLessThan(2);
    expect(Math.abs((a?.width ?? 0) - (b?.width ?? 1))).toBeLessThan(2);
    await expect(c.locator('.compare-switch')).toBeHidden();
    await shot(page, 'compare-desktop');
    // Tapping a column's plan previews that version.
    await c.getByRole('button', { name: 'Preview V1 on the plan' }).click();
    await expect(c).toHaveCount(0);
    await expect(page.locator('.designer-bar')).toContainText('Previewing V1');
    await expect(p.getByRole('tab', { name: 'V1' })).toHaveAttribute('aria-selected', 'true');
    // And Before shows the flat as it is; Esc closes Compare, back to the button.
    await p.getByRole('button', { name: 'Compare' }).click();
    await c.getByRole('button', { name: 'Show the flat as it is on the plan' }).click();
    await expect(
      page.locator('.designer-bar').getByRole('button', { name: 'Before' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await p.getByRole('button', { name: 'Compare' }).click();
    await page.keyboard.press('Escape');
    await expect(c).toHaveCount(0);
    await expect(p.getByRole('button', { name: 'Compare' })).toBeFocused();
    expect(m.calls.length - before).toBe(1);
  });

  test('after accepting, a piece moved by hand is kept by the next version (36)', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await setup(page);
    const m = await mock(page);
    await openSample(page);
    await designFlat(page);
    const p = panel(page);
    await p.getByRole('button', { name: 'Accept…' }).click();
    await page
      .getByRole('dialog', { name: 'Put V1 into your renovation' })
      .getByRole('button', { name: /^Accept \d+ changes$/ })
      .click();
    await waitSaved(page);
    // Move the sofa by hand, 0.4 m to the left.
    const pid = planId(page);
    const saved = async () =>
      page.evaluate(async (id) => (await fetch(`/api/projects/${id}`)).json(), pid);
    const after0 = (await saved()).renovation.levels[0];
    const sofaId = Object.values(
      after0.items as Record<string, { id: string; assetId: string }>,
    ).find((i) => i.assetId === 'sofa-3')?.id as string;
    expect(sofaId).toBeTruthy();
    await p.getByRole('button', { name: 'Close the designer' }).click();
    const sofa = page.locator(`[data-hit="item:${sofaId}"]`);
    const outline = () => sofa.locator('polygon').getAttribute('points');
    const was = await outline();
    // Where nothing else (the rug, a point on the wall) lies over it.
    const at = await page.evaluate((hit) => {
      const r = document.querySelector(`[data-hit="${hit}"]`)?.getBoundingClientRect();
      if (!r) return null;
      for (let fy = 0.1; fy < 1; fy += 0.1) {
        for (let fx = 0.1; fx < 1; fx += 0.1) {
          const x = r.left + r.width * fx;
          const y = r.top + r.height * fy;
          const el = document.elementFromPoint(x, y)?.closest('[data-hit]');
          if (el?.getAttribute('data-hit') === hit) return { x, y };
        }
      }
      return null;
    }, `item:${sofaId}`);
    if (!at) throw new Error('the sofa is covered');
    await page.mouse.click(at.x, at.y);
    await expect(page.getByRole('heading', { name: '3-seat sofa' })).toBeVisible();
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(outline).not.toBe(was);
    await page.keyboard.press('Escape');
    await waitSaved(page);
    const moved = await outline();
    const xNow = (await saved()).renovation.levels[0].items[sofaId].position.x;
    expect(xNow).toBeCloseTo(after0.items[sofaId].position.x - 0.4, 2);

    // Iterate on the whole design: the composer lists the sofa, kept as moved.
    await page.getByRole('button', { name: 'Designs (1)' }).click();
    await p.getByRole('button', { name: 'Change something' }).click();
    const held = p.getByRole('region', { name: 'Kept as you changed them' });
    await expect(held).toContainText(/sofa \(moved\)/i);
    // × unlocks it; Keep locks it again.
    await held.getByRole('button', { name: /^Unlock .*sofa \(moved\)/i }).click();
    await expect(held).toContainText('redone this time');
    await held.getByRole('button', { name: 'Keep' }).click();
    await held.scrollIntoViewIfNeeded();
    await shot(page, 'kept-as-changed-desktop');
    await expect(
      p.getByRole('checkbox', { name: 'Keep Living and dining: furniture' }),
    ).toBeChecked();
    const before = m.calls.length;
    await p.getByRole('button', { name: /^Make V2 · about US\$/ }).click();
    const check = page.getByRole('dialog', { name: 'Make V2' });
    if (await check.isVisible().catch(() => false)) {
      await check.getByRole('button', { name: /^Make V2 · about/ }).click();
    }
    await expect(p.getByRole('tab', { name: 'V2' })).toHaveAttribute('aria-selected', 'true', {
      timeout: 30_000,
    });
    await expect(p.getByText(/^Done in /)).toBeVisible({ timeout: 30_000 });
    // The requests mark the sofa fixed: listed as kept, and in place in the living room's step.
    const sent = m.calls.slice(before);
    expect(sent.map((c) => c.step)).toContain('layout');
    const living = sent.find((c) => c.step.startsWith('furnish "Living'));
    expect(living?.body).toMatch(/sofa \(moved\)/i);
    expect(living?.body).toMatch(
      /\\"kind\\":\\"sofa-3\\",\\"size\\":\[[^\]]*\],\\"keep\\":\\"in-place\\"/,
    );
    // V2's sofa is where it was moved to, on the plan the version previews.
    await expect(page.locator('.designer-bar')).toContainText('Previewing V2');
    await expect(sofa).toHaveCount(1);
    expect(await outline()).toBe(moved);
    // The stored version keeps the hand-edit lock in its request.
    const locks = await page.evaluate(
      (id) =>
        new Promise<unknown[]>((resolve, reject) => {
          const req = indexedDB.open('dhd-designs');
          req.onsuccess = () => {
            const tx = req.result.transaction('designs', 'readonly');
            const all = tx.objectStore('designs').getAll();
            tx.oncomplete = () => {
              const list = all.result as {
                projectId: string;
                n: number;
                request: { locks: unknown[] };
              }[];
              resolve(list.find((d) => d.projectId === id && d.n === 2)?.request.locks ?? []);
              req.result.close();
            };
          };
          req.onerror = () => reject(req.error);
        }),
      pid,
    );
    expect(locks).toContainEqual(expect.objectContaining({ by: 'hand-edit', aspect: 'furniture' }));
  });

  test('a limit of US$0.03: the cost check says so, and the run pauses; Stop here keeps it (37)', async ({
    page,
  }) => {
    await setup(page, 'anthropic', { 'dhd-ai-cap': '0.03' });
    const m = await mock(page);
    await openSample(page);
    await page.getByRole('button', { name: 'Design my flat with AI' }).click();
    await page.getByRole('button', { name: 'Next: check the cost' }).click();
    const check = page.getByRole('dialog', { name: 'Check the cost' });
    await expect(check).toContainText('This would take you past your US$0.03 limit for this tab.');
    await check.getByRole('button', { name: /^Design anyway · about US\$/ }).click();
    const pause = page.getByRole('dialog', { name: /You’ve reached your US\$0\.03 limit/ });
    await expect(pause).toBeVisible({ timeout: 30_000 });
    await expect(pause.getByRole('button', { name: 'Finish the design' })).not.toBeFocused();
    await pause.getByRole('button', { name: 'Stop here, keep what’s done' }).click();
    await expect(panel(page).getByText('Stopped. Kept 1 of 5 steps.')).toBeVisible();
    expect(m.calls).toHaveLength(1);
  });

  test('a 429 with retry-after 1 s: waits, then the step goes through (38)', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Design my flat with AI' }).click();
    await page.getByRole('button', { name: 'Next: check the cost' }).click();
    await page.getByRole('button', { name: /^Design my flat · about US\$/ }).click();
    await expect(panel(page).getByText('Waiting 1 s (1 of 2)')).toBeVisible({ timeout: 30_000 });
    await expect(panel(page).getByText(/^Done in /)).toBeVisible({ timeout: 30_000 });
    await expect(panel(page).locator('.step-row-done')).toHaveCount(5);
  });

  test('Stop mid-run keeps what’s done; Finish the design asks only for the rest; reload keeps it, no key stored (39, 40)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    let held: (() => void)[] = [];
    let rooms = 0;
    let holding = true;
    const m = await mock(page, {
      reply: (c) => {
        if (c.step === 'layout') return null;
        rooms++;
        // The first room answers; the others hang until stopped.
        return rooms === 1 || !holding ? null : new Promise<void>((r) => held.push(r));
      },
    });
    await openSample(page);
    await page.getByRole('button', { name: 'Design my flat with AI' }).click();
    await page.getByRole('button', { name: 'Next: check the cost' }).click();
    await page.getByRole('button', { name: /^Design my flat · about US\$/ }).click();
    const p = panel(page);
    await expect(p.locator('.step-row-done')).toHaveCount(2, { timeout: 30_000 });
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await p.getByRole('button', { name: 'Stop' }).click();
    await expect(p.getByText(/^Stopped\. Kept 2 of 5 steps\./)).toBeVisible();
    await expect(p.getByRole('tab', { name: 'V1, stopped' })).toBeVisible();
    for (const r of held) r();
    held = [];
    holding = false;
    const before = m.calls.length;
    // A room not designed can be tried on its own, priced as one step.
    await expect(
      p.getByRole('button', { name: /^Try this room again · about US\$\d/ }),
    ).toHaveCount(3);
    await p.getByRole('button', { name: /^Finish the design · about US\$/ }).click();
    const check = page.getByRole('dialog', { name: 'Finish the design' });
    if (await check.isVisible().catch(() => false)) {
      await check.getByRole('button', { name: /^Finish the design · about/ }).click();
    }
    await expect(p.getByText(/^Done in /)).toBeVisible({ timeout: 30_000 });
    expect(m.calls.length - before).toBe(3);
    expect(m.calls.slice(before).every((c) => c.step !== 'layout')).toBe(true);

    // 40: after a reload the version is there, and previews; no key in what's stored.
    await page.reload();
    await waitSaved(page);
    await page.getByRole('button', { name: 'Designs (1)' }).click();
    await expect(panel(page).getByRole('tab', { name: /^V1/ })).toBeVisible();
    await expect(page.locator('.designer-bar')).toContainText('Previewing V1');
    const stored = await page.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const req = indexedDB.open('dhd-designs');
          req.onsuccess = () => {
            const tx = req.result.transaction(['designs', 'briefs'], 'readonly');
            const a = tx.objectStore('designs').getAll();
            const b = tx.objectStore('briefs').getAll();
            tx.oncomplete = () => resolve(JSON.stringify([a.result, b.result]));
          };
          req.onerror = () => reject(req.error);
        }),
    );
    expect(stored.length).toBeGreaterThan(1000);
    expect(stored).not.toContain(KEY);
    expect(stored).not.toMatch(/sk-ant|x-api-key/);
  });

  test('deleting a plan deletes its designs, one at a time and with Clear all', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    await mock(page);
    for (const how of ['one', 'all'] as const) {
      await openSample(page);
      const doomed = planId(page);
      await designFlat(page);
      expect(await storedFor(page, doomed)).toEqual({ designs: 1, briefs: 1 });
      // Another copy of the sample: it is the one kept, so the first can go.
      await page.getByRole('button', { name: 'Projects' }).click();
      await page.getByRole('button', { name: 'New copy of the sample flat' }).click();
      await waitSaved(page);
      await expect.poll(() => planId(page)).not.toBe(doomed);
      await page.getByRole('button', { name: 'Projects' }).click();
      await page.getByRole('button', { name: 'Manage your plans…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Your plans' });
      if (how === 'one') {
        await dialog
          .getByRole('listitem')
          .nth(1)
          .getByRole('button', { name: /^Delete/ })
          .click();
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      } else {
        await dialog.getByRole('button', { name: 'Clear all plans' }).click();
        await dialog.getByRole('button', { name: 'Clear all', exact: true }).click();
      }
      await expect(dialog.getByRole('listitem')).toHaveCount(1);
      await expect.poll(() => storedFor(page, doomed)).toEqual({ designs: 0, briefs: 0 });
      await page.keyboard.press('Escape');
    }
  });

  test('opening another plan mid-run asks first; Stop and open keeps the steps done', async ({
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
    await page.getByRole('button', { name: 'Design my flat with AI' }).click();
    await page.getByRole('button', { name: 'Next: check the cost' }).click();
    await page.getByRole('button', { name: /^Design my flat · about US\$/ }).click();
    await expect(panel(page).locator('.step-row-done')).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => held.length).toBeGreaterThan(0);
    const open = async () => {
      await page.getByRole('button', { name: 'Projects' }).click();
      await page.getByRole('button', { name: 'New copy of the sample flat' }).click();
    };
    await open();
    const ask = page.getByRole('dialog', { name: 'Stop designing and open the other plan?' });
    await expect(ask).toBeVisible();
    await expect(ask.getByRole('button', { name: 'Keep designing' })).toBeFocused();
    await ask.getByRole('button', { name: 'Keep designing' }).click();
    await expect(ask).toHaveCount(0);
    expect(planId(page)).toBe(first);
    await expect(panel(page).getByRole('button', { name: 'Stop' })).toBeVisible();
    await open();
    await ask.getByRole('button', { name: 'Stop and open' }).click();
    await waitSaved(page);
    await expect.poll(() => planId(page)).not.toBe(first);
    for (const r of held) r();
    // The first plan keeps its version, with the layout done.
    expect((await storedFor(page, first)).designs).toBe(1);
  });

  test('deleting the open plan mid-run, then Keep designing: nothing deleted, no error', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page);
    const held: (() => void)[] = [];
    await mock(page, {
      reply: (c) => (c.step === 'layout' ? null : new Promise<void>((r) => held.push(r))),
    });
    // A plan that can be deleted, open: the sample imported as a plan of one's own.
    await openSample(page);
    const sample = planId(page);
    const doc = await page.evaluate(
      async (pid) => (await fetch(`/api/projects/${pid}`)).json(),
      sample,
    );
    await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
      name: 'my-flat.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...doc, name: 'My flat' })),
    });
    await expect.poll(() => planId(page)).not.toBe(sample);
    await waitSaved(page);
    const doomed = planId(page);
    await page.keyboard.press('1');
    await page.getByRole('button', { name: 'Design my flat with AI' }).click();
    await page.getByRole('button', { name: 'Next: check the cost' }).click();
    await page.getByRole('button', { name: /^Design my flat · about US\$/ }).click();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.getByRole('button', { name: 'Manage your plans…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Your plans' });
    await dialog.getByRole('button', { name: 'Delete My flat' }).click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    const ask = page.getByRole('dialog', { name: 'Stop designing and open the other plan?' });
    await ask.getByRole('button', { name: 'Keep designing' }).click();
    await expect(ask).toHaveCount(0);
    await expect(dialog.getByRole('listitem')).toHaveCount(2);
    await expect(dialog).not.toContainText('Couldn’t delete');
    expect(planId(page)).toBe(doomed);
    await page.keyboard.press('Escape');
    await expect(panel(page).getByRole('button', { name: 'Stop' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Stop' }).click();
    for (const r of held) r();
  });

  for (const provider of ['openai', 'gemini'] as const) {
    test(`${provider}: a whole design, with usage read from the final chunks (41)`, async ({
      page,
    }) => {
      await setup(page, provider);
      const m = await mock(page);
      await openSample(page);
      await designFlat(page);
      expect(m.calls).toHaveLength(5);
      expect(m.calls.every((c) => c.provider === provider)).toBe(true);
      await expect(panel(page).getByText(/^Done in /)).toContainText(
        '30,000 tokens (15,000 from cache)',
      );
    });
  }

  test('a price left empty keeps AI settings open, with why', async ({ page }) => {
    await setup(page);
    await openSample(page);
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.getByRole('button', { name: /AI assistant/ }).click();
    const dialog = page.getByRole('dialog', { name: 'AI assistant' });
    await dialog.getByLabel('Output').fill('');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveText(
      'Enter all three prices, in US$ per million tokens, to use them.',
    );
  });

  test('a view-only link has no designer (42)', async ({ page, browser }) => {
    await setup(page);
    await openSample(page);
    await expect(page.getByRole('button', { name: 'Design my flat with AI' })).toBeVisible();
    await page.getByRole('button', { name: 'Share' }).click();
    const viewLink = await page.getByLabel('View-only link').inputValue();
    const viewer = await (await browser.newContext()).newPage();
    await viewer.goto(viewLink);
    await expect(viewer.getByText('View only.')).toBeVisible();
    await viewer.keyboard.press('1');
    await expect(viewer.getByRole('heading', { name: 'Renovation' })).toBeVisible();
    await expect(viewer.getByRole('button', { name: /Design my flat|Designs \(/ })).toHaveCount(0);
  });
});

test.describe('tablet, 1024 × 768', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });

  test('the panel is a column beside the plan, and the plan is refitted to show the design', async ({
    page,
  }) => {
    await setup(page);
    await mock(page);
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    await designFlat(page);
    const box = await panel(page).boundingBox();
    expect(box?.width ?? 0).toBe(360);
    expect(box?.x ?? 0).toBeGreaterThan(600);
    // The plan fills what is left, and the designed pieces are in sight on it.
    const plan = await page.locator('.plan-svg').boundingBox();
    expect(plan?.width ?? 0).toBeGreaterThan(450);
    const seen = await page.locator('[data-hit^="item:"]').evaluateAll((els, area) => {
      const a = area as { x: number; y: number; width: number; height: number };
      return els.filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > a.x && r.left < a.x + a.width && r.bottom > a.y && r.top < a.y + a.height;
      }).length;
    }, plan);
    expect(seen).toBeGreaterThan(20);
  });
});

test.describe('phone, 390 px, fingers only (43)', () => {
  const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];
  test.use({ ...iPhone, viewport: { width: 390, height: 844 } });

  const noSideways = async (page: Page) =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  /**
   * A finger dragged sideways across an element by `dx` pixels, as the pointer events a touch
   * sends (a raw CDP touch drag leaves Chromium's emulated touch eating the next tap).
   */
  const swipe = async (page: Page, el: ReturnType<Page['locator']>, dx: number) => {
    await el.evaluate((node, d) => {
      const r = node.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const send = (type: string, px: number) =>
        node.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            clientX: px,
            clientY: y,
          }),
        );
      send('pointerdown', x);
      for (let i = 1; i <= 6; i++) send('pointermove', x + (d * i) / 6);
      send('pointerup', x + d);
    }, dx);
  };
  const tall = async (page: Page, name: RegExp | string) => {
    const box = await page.getByRole('button', { name }).first().boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  };

  test('brief, cost check, run, versions, preview, accept and change something', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await setup(page);
    const m = await mock(page);
    await page.goto('/');
    await waitSaved(page);
    await page.getByRole('button', { name: 'Show plan details' }).tap();
    const entry = page.getByRole('button', { name: 'Design my flat with AI' });
    await entry.scrollIntoViewIfNeeded();
    await tall(page, 'Design my flat with AI');
    await entry.tap();

    // The brief, one section a step.
    const dialog = page.getByRole('dialog', { name: 'Design my flat' });
    await expect(dialog.getByText('1 of 7')).toBeVisible();
    await noSideways(page);
    await tall(page, 'More: Elderly');
    await dialog.getByRole('button', { name: 'More: Elderly' }).tap();
    for (let i = 0; i < 6; i++) await dialog.getByRole('button', { name: 'Next' }).tap();
    await expect(dialog.getByText('7 of 7')).toBeVisible();
    await dialog.getByRole('button', { name: 'Next' }).tap();
    const check = page.getByRole('dialog', { name: 'Check the cost' });
    await expect(check.locator('.cost-figure')).toContainText(/About US\$/);
    await noSideways(page);
    await check.getByRole('button', { name: /^Design my flat · about/ }).tap();

    const p = panel(page);
    await expect(p.getByText(/^Done in /)).toBeVisible({ timeout: 30_000 });
    await noSideways(page);
    const sheet = await p.boundingBox();
    expect(sheet?.width ?? 0).toBeLessThanOrEqual(390);
    await expect(page.locator('.designer-bar')).toContainText('Previewing V1');
    // The sheet: tap its handle for full height, drag it down to fold it, up to open it.
    const handle = p.locator('.sheet-handle');
    await handle.tap();
    await expect(p).toHaveClass(/designer-full/);
    const drag = async (dy: number) => {
      const h = await handle.boundingBox();
      if (!h) throw new Error('no handle');
      const x = h.x + h.width / 2;
      const y = h.y + h.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + dy, { steps: 5 });
      await page.mouse.up();
    };
    await drag(120);
    await expect(p).toHaveClass(/designer-half/);
    await drag(120);
    await expect(p).toHaveClass(/designer-folded/);
    await expect(p.getByRole('heading', { name: /Designer/ })).toBeVisible();
    // Folded, the plan has the screen, refitted above the header.
    const plan = await page.locator('.plan-svg').boundingBox();
    expect(plan?.height ?? 0).toBeGreaterThan(400);
    await drag(-120);
    await expect(p).toHaveClass(/designer-half/);
    const acceptBtn = p.getByRole('button', { name: 'Accept…' });
    expect((await acceptBtn.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Change something: the kitchen's furniture; the composer fits the phone.
    await p.getByRole('button', { name: 'Change something' }).tap();
    await p.getByLabel('What to change').selectOption({ label: 'Kitchen' });
    await p.getByLabel('What would you like different?').fill('more storage');
    await noSideways(page);
    const make = p.getByRole('button', { name: /^Make V2/ });
    await make.scrollIntoViewIfNeeded();
    await make.tap();
    await expect(p.getByRole('tab', { name: 'V2' })).toHaveAttribute('aria-selected', 'true', {
      timeout: 30_000,
    });
    await expect(p.getByText(/^Done in /)).toBeVisible({ timeout: 30_000 });
    expect(m.calls).toHaveLength(6);

    // Compare: one column at a time, Before / V1 / V2 above it, and a swipe across it.
    await p.getByRole('button', { name: 'Compare' }).tap();
    const c = compare(page);
    const switcher = c.getByRole('group', { name: 'Column' });
    await expect(switcher.getByRole('button')).toHaveText(['Before', 'V1', 'V2']);
    await expect(switcher.getByRole('button', { name: 'V2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const shown = c.locator('.compare-col:visible');
    await expect(shown).toHaveCount(1);
    await expect(shown.getByRole('heading')).toHaveText(/^V2 /);
    await noSideways(page);
    for (const b of await switcher.getByRole('button').all()) {
      expect((await b.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    expect(
      (await c.getByRole('button', { name: 'Done' }).boundingBox())?.height ?? 0,
    ).toBeGreaterThanOrEqual(44);
    await shot(page, 'compare-phone');
    await switcher.getByRole('button', { name: 'Before' }).tap();
    await expect(shown.getByRole('heading')).toHaveText(/^Before /);
    // Tapping the column's plan shows it on the plan, and Compare closes.
    await shown.locator('.compare-plan').tap();
    await expect(c).toHaveCount(0);
    await expect(
      page.locator('.designer-bar').getByRole('button', { name: 'Before' }),
    ).toHaveAttribute('aria-pressed', 'true');
    // A swipe to the left: the next column.
    await p.getByRole('button', { name: 'Compare' }).tap();
    await switcher.getByRole('button', { name: 'Before' }).tap();
    await swipe(page, c.locator('.compare-col:visible .compare-facts'), -160);
    await expect(c.locator('.compare-col:visible').getByRole('heading')).toHaveText(/^V1 /);
    await shot(page, 'compare-phone-v1');
    await c.getByRole('button', { name: 'Done' }).tap();
    await expect(c).toHaveCount(0);
    // Back to V1 by its tab.
    await p.getByRole('tab', { name: 'V1' }).tap();
    await expect(page.locator('.designer-bar')).toContainText('Previewing V1');

    // Accept from the bar.
    await page.locator('.designer-bar').getByRole('button', { name: 'Accept…' }).tap();
    const accept = page.getByRole('dialog', { name: 'Put V1 into your renovation' });
    await noSideways(page);
    await accept.getByRole('button', { name: /^Accept \d+ changes$/ }).tap();
    await expect(page.locator('.toast')).toContainText('Design V1 is in your renovation.');
    await noSideways(page);
  });
});
