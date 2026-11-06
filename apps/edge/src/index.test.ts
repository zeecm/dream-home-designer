import { afterEach, describe, expect, it, vi } from 'vitest';

// The container runtime only exists on Cloudflare: stand in an API that answers 200.
const forwarded: string[] = [];
vi.mock('@cloudflare/containers', () => ({
  Container: Object,
  getContainer: () => ({
    fetch: async (req: Request) => {
      forwarded.push(`${req.method} ${new URL(req.url).pathname}`);
      return new Response('{}', { status: 200 });
    },
  }),
}));

const { default: worker, EVENT_NAMES } = await import('./index');
type WorkerEnv = Parameters<typeof worker.fetch>[1];

/** A per-key fixed-window limiter, as the RateLimit binding behaves within a minute. */
function limiter(limit: number) {
  const counts = new Map<string, number>();
  return {
    async limit({ key }: { key: string }) {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

/** Just enough of D1 for the quota's upsert; `broken` is a database without the table. */
function fakeD1(broken = false) {
  const rows = new Map<string, number>();
  return {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        async first() {
          if (broken) throw new Error('D1_ERROR: no such table: create_quota');
          const k = `${String(args[0])}|${String(args[1])}`;
          const n = (rows.get(k) ?? 0) + 1;
          rows.set(k, n);
          return { count: n };
        },
        async run() {},
      }),
    }),
  };
}

function env(over: Record<string, unknown> = {}): WorkerEnv {
  return {
    WRITE_LIMIT: limiter(1000),
    CREATE_LIMIT: limiter(1000),
    COMMENT_LIMIT: limiter(30),
    API: {},
    ...over,
  } as unknown as WorkerEnv;
}

const req = (method: string, path: string, ip = '203.0.113.7') =>
  new Request(`https://dhd.example${path}`, {
    method,
    headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });

afterEach(() => {
  forwarded.length = 0;
  vi.restoreAllMocks();
});

describe('comment writes at the edge', () => {
  it('allows 30 comment writes a minute per address, then 429 with the copy; GETs never count', async () => {
    const e = env();
    const paths = [
      '/api/projects/prj_a/comments',
      '/api/projects/prj_a/comments/t_1/replies',
      '/api/projects/prj_a/comments/t_1',
    ];
    for (let i = 0; i < 30; i++) {
      const method = ['POST', 'PATCH', 'DELETE'][i % 3] ?? 'POST';
      const res = await worker.fetch(req(method, paths[i % 3] ?? ''), e);
      expect(res.status).toBe(200);
    }
    const res = await worker.fetch(req('POST', '/api/projects/prj_a/comments'), e);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toMatchObject({
      error: "You're commenting very fast. Wait a minute and try again.",
    });
    for (let i = 0; i < 30; i++) {
      expect((await worker.fetch(req('GET', '/api/projects/prj_a/comments'), e)).status).toBe(200);
    }
    // Someone else, and the plan's own saves, are unaffected.
    expect(
      (await worker.fetch(req('POST', '/api/projects/prj_a/comments', '198.51.100.2'), e)).status,
    ).toBe(200);
    expect((await worker.fetch(req('PUT', '/api/projects/prj_a'), e)).status).toBe(200);
    expect(forwarded).toContain('PUT /projects/prj_a');
  });

  it('caps a visitor at 300 comment posts a day; resolves and deletes do not count', async () => {
    const e = env({ COMMENT_LIMIT: limiter(10_000), DB: fakeD1(), KEYS_SECRET: 's' });
    for (let i = 0; i < 300; i++) {
      expect((await worker.fetch(req('POST', '/api/projects/prj_a/comments'), e)).status).toBe(200);
    }
    for (const method of ['PATCH', 'DELETE']) {
      const res = await worker.fetch(req(method, '/api/projects/prj_a/comments/t_1'), e);
      expect(res.status).toBe(200);
    }
    const res = await worker.fetch(req('POST', '/api/projects/prj_a/comments'), e);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: "That's a lot of comments for one day. Try again tomorrow.",
    });
  });

  it('fails open without the quota table, and logs quotaUnavailable', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = env({ DB: fakeD1(true) });
    expect((await worker.fetch(req('POST', '/api/projects/prj_a/comments'), e)).status).toBe(200);
    expect(logged.mock.calls.map((c) => c[0])).toContain('quotaUnavailable');
  });

  it('lets comments through, and logs it, when the rate-limit binding is missing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = env({ COMMENT_LIMIT: undefined });
    expect((await worker.fetch(req('POST', '/api/projects/prj_a/comments'), e)).status).toBe(200);
    expect(logged.mock.calls.map((c) => c[0])).toContain('commentLimitUnbound');
  });

  it('accepts the comment event', () => {
    expect(EVENT_NAMES.has('comment')).toBe(true);
  });
});
