import { Container, getContainer } from '@cloudflare/containers';

export interface Env {
  API: DurableObjectNamespace<ApiContainer>;
  WRITE_LIMIT: RateLimit;
  CREATE_LIMIT: RateLimit;
  R2_ENDPOINT: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY: string;
  R2_SECRET_KEY: string;
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

    return getContainer(env.API).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
