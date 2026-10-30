import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, handleAuth, memoryStore, seal, unseal } from './auth';

const env = {
  GOOGLE_CLIENT_ID: 'client-123',
  GOOGLE_CLIENT_SECRET: 'shh',
  KEYS_SECRET: 'keys-secret',
  AUTH_ORIGINS: '^https://dream-home-designer\\.pages\\.dev$',
};
const SITE = 'https://dream-home-designer.pages.dev';

const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Google's token endpoint, answering with an ID token for this person. */
function google(claims: Record<string, unknown>) {
  const calls: URLSearchParams[] = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id_token: `x.${b64(claims)}.sig` }));
  }) as typeof fetch;
  return { fetcher, calls };
}

const cookieFrom = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

async function signIn(store = memoryStore(), claims: Record<string, unknown> = {}) {
  const startRes = await handleAuth(
    new Request(`${SITE}/api/auth/google?return=/?p=prj_a`),
    '/auth/google',
    env,
    store,
  );
  const location = new URL(startRes?.headers.get('Location') ?? '');
  const flow = cookieFrom(startRes as Response, 'dhd_oauth');
  const state = location.searchParams.get('state');
  const g = google({
    iss: 'https://accounts.google.com',
    aud: 'client-123',
    sub: 'g-1',
    email: 'mah@example.com',
    email_verified: true,
    name: 'Mah',
    ...claims,
  });
  const res = await handleAuth(
    new Request(`${SITE}/api/auth/google/callback?state=${state}&code=abc`, {
      headers: { Cookie: `dhd_oauth=${flow}` },
    }),
    '/auth/google/callback',
    env,
    store,
    g.fetcher,
  );
  return { res: res as Response, store, location, calls: g.calls };
}

const as = (token: string, init: RequestInit = {}) => ({
  ...init,
  headers: { Cookie: `${SESSION_COOKIE}=${token}`, ...(init.headers ?? {}) },
});

describe('sign in with Google', () => {
  it('is off until the client id and secrets are set', async () => {
    const res = await handleAuth(new Request(`${SITE}/api/auth/me`), '/auth/me', {}, null);
    expect(await res?.json()).toEqual({ enabled: false, user: null });
    expect(await handleAuth(new Request(`${SITE}/api/projects`), '/projects', env, null)).toBe(
      null,
    );
  });

  it('sends the browser to Google with PKCE, and signs the person in on the way back', async () => {
    const { res, store, location, calls } = await signIn();
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('redirect_uri')).toBe(`${SITE}/api/auth/google/callback`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(calls[0]?.get('code_verifier')).toBeTruthy();
    expect(calls[0]?.get('client_secret')).toBe('shh');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/?p=prj_a');
    const token = cookieFrom(res, SESSION_COOKIE) ?? '';
    expect(token.length).toBeGreaterThan(30);
    expect(res.headers.getSetCookie().join()).toMatch(/HttpOnly; Secure; SameSite=Lax/);

    const me = await handleAuth(
      new Request(`${SITE}/api/auth/me`, as(token)),
      '/auth/me',
      env,
      store,
    );
    expect(await me?.json()).toEqual({
      enabled: true,
      user: { email: 'mah@example.com', name: 'Mah', picture: '' },
    });
    // Signing in again is the same person.
    await signIn(store);
    expect(store.users.size).toBe(1);
  });

  it('refuses a callback whose state does not match, another site, or a foreign token', async () => {
    const store = memoryStore();
    const bad = await handleAuth(
      new Request(`${SITE}/api/auth/google/callback?state=x&code=abc`, {
        headers: { Cookie: 'dhd_oauth=a.b.c.d' },
      }),
      '/auth/google/callback',
      env,
      store,
      google({}).fetcher,
    );
    expect(bad?.headers.get('Location')).toBe('/?signin=expired');
    const other = await handleAuth(
      new Request('https://evil.example/api/auth/google'),
      '/auth/google',
      env,
      store,
    );
    expect(other?.status).toBe(403);
    const { res } = await signIn(memoryStore(), { aud: 'someone-else' });
    expect(res.headers.get('Location')).toBe('/?signin=failed');
  });

  it('never returns to another site after signing in', async () => {
    const store = memoryStore();
    const startRes = await handleAuth(
      new Request(`${SITE}/api/auth/google?return=//evil.example/x`),
      '/auth/google',
      env,
      store,
    );
    const flow = cookieFrom(startRes as Response, 'dhd_oauth') ?? '';
    const back = flow.split('.')[2] ?? '';
    expect(atob(back.replace(/-/g, '+').replace(/_/g, '/'))).toBe('/');
  });
});

describe('the plans a person keeps', () => {
  it('keeps keys sealed, returns them to the signed-in person, and forgets on request', async () => {
    const { res, store } = await signIn();
    const token = cookieFrom(res, SESSION_COOKIE) ?? '';
    const put = (id: string, body: unknown) =>
      handleAuth(
        new Request(
          `${SITE}/api/me/projects/${id}`,
          as(token, {
            method: 'PUT',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
        `/me/projects/${id}`,
        env,
        store,
      );
    expect((await put('prj_a', { name: 'Flat', ownerKey: 'owner-1' }))?.status).toBe(200);
    // A later save from a device without the key keeps the key.
    await put('prj_a', { name: 'My flat' });
    const list = await handleAuth(
      new Request(`${SITE}/api/me/projects`, as(token)),
      '/me/projects',
      env,
      store,
    );
    expect(await list?.json()).toMatchObject({
      projects: [{ id: 'prj_a', name: 'My flat', ownerKey: 'owner-1', editKey: '' }],
    });
    const raw = await store.listProjects([...store.users.values()][0]?.id ?? '');
    expect(raw[0]?.ownerKey).not.toContain('owner-1');

    // Not signed in, or a form from another site: refused.
    const anon = await handleAuth(
      new Request(`${SITE}/api/me/projects`),
      '/me/projects',
      env,
      store,
    );
    expect(anon?.status).toBe(401);
    const form = await handleAuth(
      new Request(`${SITE}/api/me/projects/prj_a`, as(token, { method: 'DELETE' })),
      '/me/projects/prj_a',
      env,
      store,
    );
    expect(form?.status).toBe(415);

    const logout = await handleAuth(
      new Request(`${SITE}/api/auth/logout`, as(token, { method: 'POST' })),
      '/auth/logout',
      env,
      store,
    );
    expect(cookieFrom(logout as Response, SESSION_COOKIE)).toBe('');
    const after = await handleAuth(
      new Request(`${SITE}/api/me/projects`, as(token)),
      '/me/projects',
      env,
      store,
    );
    expect(after?.status).toBe(401);
  });

  it('seals and unseals keys, and a wrong secret reads as no key', async () => {
    const sealed = await seal('a', 'key-1');
    expect(await unseal('a', sealed)).toBe('key-1');
    expect(await unseal('b', sealed)).toBe('');
    expect(await seal('a', '')).toBe('');
  });
});
