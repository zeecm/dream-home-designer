import { Container, getContainer } from '@cloudflare/containers';

export interface Env {
  API: DurableObjectNamespace<ApiContainer>;
  WRITE_LIMIT: RateLimit;
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
      LIST_PROJECTS: 'off',
      R2_ENDPOINT: env.R2_ENDPOINT,
      R2_BUCKET: env.R2_BUCKET,
      R2_ACCESS_KEY: env.R2_ACCESS_KEY,
      R2_SECRET_KEY: env.R2_SECRET_KEY,
    };
  }
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
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const { success } = await env.WRITE_LIMIT.limit({ key: ip });
      if (!success) return json({ error: 'too many writes, slow down' }, 429);
    }

    return getContainer(env.API).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
