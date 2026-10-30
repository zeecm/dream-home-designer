/**
 * Pages Function: forwards /api/* to the dhd-api Worker (the Go API in a Container)
 * through the API service binding, so the browser stays same-origin. Production binds
 * dhd-api; previews bind dhd-api-preview, which uses its own R2 bucket.
 */
interface Env {
  API?: { fetch: (request: Request) => Promise<Response> };
}

export const onRequest = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env.API) {
    // The client treats a non-OK health check as "no API" and saves in the browser.
    return new Response(JSON.stringify({ error: 'API not bound' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return env.API.fetch(request);
};
