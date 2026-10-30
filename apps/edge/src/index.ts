import { Container, getContainer } from '@cloudflare/containers';

export interface Env {
  API: DurableObjectNamespace<ApiContainer>;
  WRITE_LIMIT: RateLimit;
  CREATE_LIMIT: RateLimit;
  R2_ENDPOINT: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY: string;
  R2_SECRET_KEY: string;
  /** Workers Analytics Engine: one data point per usage event (no personal data). */
  EVENTS?: AnalyticsEngineDataset;
}

/** The usage events the app may send: the steps of a first plan, and the big features. */
export const EVENT_NAMES = new Set([
  'open-sample',
  'new-plan',
  'upload-plan',
  'calibrate',
  'first-wall',
  'first-room',
  'walk',
  'furnish',
  'renovation',
  'share',
  'download',
  'restore-version',
]);

/**
 * Telemetry from the app, kept here rather than in the API: errors go to the Worker's logs
 * (observability), usage events to Analytics Engine. Neither carries project ids, plan
 * content or anything about the person.
 */
export async function telemetry(request: Request, env: Env): Promise<Response> {
  const text = await request.text();
  if (text.length > 8192) return json({ error: 'too large' }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json({ error: 'not JSON' }, 400);
  }
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  if (body.kind === 'error') {
    console.error(
      JSON.stringify({
        clientError: str(body.message, 500),
        stack: str(body.stack, 2000),
        path: str(body.path, 200),
        build: str(body.build, 40),
        ua: str(request.headers.get('User-Agent'), 200),
      }),
    );
    return new Response(null, { status: 204 });
  }
  if (body.kind === 'event') {
    const name = str(body.name, 40);
    if (!EVENT_NAMES.has(name)) return json({ error: 'unknown event' }, 400);
    const country = (request as { cf?: { country?: string } }).cf?.country ?? '';
    env.EVENTS?.writeDataPoint({ blobs: [name, str(body.detail, 40), country], indexes: [name] });
    return new Response(null, { status: 204 });
  }
  return json({ error: 'unknown kind' }, 400);
}

/**
 * The Go API (apps/api) running as a Cloudflare Container. Projects live in R2, so the
 * container is stateless and can sleep when idle.
 */
export class ApiContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = '15m';

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      STORE: 'r2',
      R2_ENDPOINT: env.R2_ENDPOINT,
      R2_BUCKET: env.R2_BUCKET,
      R2_ACCESS_KEY: env.R2_ACCESS_KEY,
      R2_SECRET_KEY: env.R2_SECRET_KEY,
    };
  }
}

/** Rate-limit key: the IPv4 address, or the /64 an IPv6 client can otherwise rotate within. */
export function clientKey(ip: string | null): string {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const head = ip.split('::')[0] ?? '';
  const groups = head.split(':').filter(Boolean);
  return `${groups.slice(0, 4).join(':')}::/64`;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Reached as /api/... through the Pages Function, or directly on workers.dev.
    url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const client = clientKey(request.headers.get('CF-Connecting-IP'));
      const write = await env.WRITE_LIMIT.limit({ key: client });
      if (!write.success) return json({ error: 'too many writes, slow down' }, 429);
      if (request.method === 'POST' && url.pathname === '/projects') {
        const create = await env.CREATE_LIMIT.limit({ key: client });
        if (!create.success)
          return json({ error: 'too many new projects, try again in a minute' }, 429);
      }
    }

    if (request.method === 'POST' && url.pathname === '/telemetry') return telemetry(request, env);
    return getContainer(env.API).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
