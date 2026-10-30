/**
 * Pages Function: forwards /api/* to the dhd-api Worker (the Go API in a Container)
 * through the API service binding, so the browser stays same-origin. Production binds
 * dhd-api; previews bind dhd-api-preview, which uses its own R2 bucket.
 *
 * Plan images are addressed by their SHA-256, so their responses never change: they are
 * kept in the edge cache, and repeat fetches don't reach the container.
 */
interface Env {
  API?: { fetch: (request: Request) => Promise<Response> };
}

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

const IMAGE = /^\/api\/projects\/[a-z0-9][a-z0-9_-]{0,63}\/image\/[0-9a-f]{64}$/;

export const onRequest = async ({
  request,
  env,
  waitUntil,
}: {
  request: Request;
  env: Env;
  waitUntil: (p: Promise<unknown>) => void;
}) => {
  if (!env.API) {
    // The client treats a non-OK health check as "no API" and saves in the browser.
    return new Response(JSON.stringify({ error: 'API not bound' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const cache = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
  if (request.method === 'GET' && cache && IMAGE.test(new URL(request.url).pathname)) {
    const hit = await cache.match(request).catch(() => undefined);
    if (hit) return hit;
    const res = await env.API.fetch(request);
    if (res.ok) waitUntil(cache.put(request, res.clone()).catch(() => {}));
    return res;
  }
  return env.API.fetch(request);
};
