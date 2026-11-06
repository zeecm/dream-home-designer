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

const panel = (page: Page) => page.getByRole('complementary', { name: 'Designer' });

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
  });

  test('Change something ▸ Kitchen, Furniture: one request with the feedback; V2 (35)', async ({
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
    await p.getByRole('button', { name: /^Make V2 · about US\$/ }).click();
    await expect(p.getByRole('tab', { name: 'V2' })).toBeVisible({ timeout: 30_000 });
    await expect(p.getByText(/^Done in /)).toBeVisible({ timeout: 30_000 });
    const sent = m.calls.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toContain('more storage');
    expect(sent[0]?.body).toContain('furnish \\"Kitchen\\"');
    expect(sent[0]?.body).not.toContain('furnish \\"Living');
    await expect(p.getByRole('tab', { name: 'V1' })).toBeVisible();
    await expect(p.getByRole('tab', { name: 'V2' })).toHaveAttribute('aria-selected', 'true');
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

test.describe('phone, 390 px, fingers only (43)', () => {
  const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];
  test.use({ ...iPhone, viewport: { width: 390, height: 844 } });

  const noSideways = async (page: Page) =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
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
