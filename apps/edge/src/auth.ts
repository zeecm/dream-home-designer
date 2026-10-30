/**
 * Accounts: sign in with Google (OAuth 2.0 code flow with PKCE), a session cookie, and the
 * list of plans a person keeps, with the keys that let them edit, so signing in on another
 * device brings their plans along. Storage is behind `AuthStore`: D1 in production, a Map in
 * tests.
 */

export interface User {
  id: string;
  googleSub: string;
  email: string;
  name: string;
  picture: string;
}

export interface KeptProject {
  projectId: string;
  name: string;
  ownerKey: string;
  editKey: string;
  sample: boolean;
  updatedAt: number;
}

export interface AuthStore {
  upsertUser(u: Omit<User, 'id'>, newId: string, now: number): Promise<User>;
  createSession(tokenHash: string, userId: string, now: number, expiresAt: number): Promise<void>;
  sessionUser(tokenHash: string, now: number): Promise<User | null>;
  deleteSession(tokenHash: string): Promise<void>;
  listProjects(userId: string): Promise<KeptProject[]>;
  putProject(userId: string, p: KeptProject): Promise<void>;
  deleteProject(userId: string, projectId: string): Promise<void>;
}

export interface AuthEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Encrypts the edit keys kept for people (AES-GCM). */
  KEYS_SECRET?: string;
  /** A regular expression the site's origin must match for sign-in to start. */
  AUTH_ORIGINS?: string;
}

export const SESSION_COOKIE = 'dhd_session';
const FLOW_COOKIE = 'dhd_oauth';
const SESSION_DAYS = 30;
const MAX_PROJECTS = 500;

// ------------------------------------------------------------------------ helpers

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}

async function aesKey(secret: string) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`keys:${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Seals a project key for storage; empty stays empty. */
export async function seal(secret: string, plain: string): Promise<string> {
  if (!plain) return '';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await aesKey(secret),
    enc.encode(plain),
  );
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function unseal(secret: string, sealed: string): Promise<string> {
  if (!sealed) return '';
  const [iv, ct] = sealed.split('.');
  if (!iv || !ct) return '';
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(iv) },
      await aesKey(secret),
      fromB64url(ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return ''; // sealed under an older secret: the key is gone, the plan stays listed
  }
}

export function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const setCookie = (name: string, value: string, maxAge: number, path = '/') =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

/** The site the browser is on: where the Pages Function forwarded the request from. */
function siteOrigin(request: Request): string {
  return new URL(request.url).origin;
}

/** Only a path on this site to return to after signing in: never another site. */
function safeReturn(path: string | null): string {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return '/';
  return path.slice(0, 500);
}

const enabled = (env: AuthEnv) =>
  !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET && !!env.KEYS_SECRET;

// ------------------------------------------------------------------------ the flow

/** GET /auth/google: off to Google, remembering (signed, in a cookie) where to come back. */
async function start(request: Request, env: AuthEnv): Promise<Response> {
  if (!enabled(env)) return json({ error: 'sign-in is not set up' }, 404);
  const origin = siteOrigin(request);
  if (!new RegExp(env.AUTH_ORIGINS ?? '^$').test(origin)) {
    return json({ error: 'sign-in is not available on this address' }, 403);
  }
  const state = randomToken(16);
  const verifier = randomToken(32);
  const back = safeReturn(new URL(request.url).searchParams.get('return'));
  const flow = `${state}.${verifier}.${b64url(enc.encode(back))}`;
  const signed = `${flow}.${await hmac(env.KEYS_SECRET ?? '', flow)}`;
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))),
  );
  const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: `${origin}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: google.toString(),
      'Set-Cookie': setCookie(FLOW_COOKIE, signed, 600, '/api/auth'),
      'Cache-Control': 'no-store',
    },
  });
}

interface IdClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  exp?: number;
}

/**
 * GET /auth/google/callback: checks the state against the signed cookie, trades the code
 * for tokens (with the secret and the PKCE verifier), and signs the person in. The ID token
 * comes straight from Google's token endpoint over TLS, so its claims are read, not verified.
 */
async function callback(
  request: Request,
  env: AuthEnv,
  store: AuthStore,
  fetcher: typeof fetch,
  now: number,
): Promise<Response> {
  if (!enabled(env)) return json({ error: 'sign-in is not set up' }, 404);
  const url = new URL(request.url);
  const fail = (why: string) =>
    new Response(null, {
      status: 302,
      headers: {
        Location: `/?signin=${encodeURIComponent(why)}`,
        'Set-Cookie': setCookie(FLOW_COOKIE, '', 0, '/api/auth'),
      },
    });
  const raw = cookie(request, FLOW_COOKIE);
  const parts = raw?.split('.') ?? [];
  if (parts.length !== 4) return fail('expired');
  const [state, verifier, back64, mac] = parts as [string, string, string, string];
  if ((await hmac(env.KEYS_SECRET ?? '', `${state}.${verifier}.${back64}`)) !== mac) {
    return fail('expired');
  }
  if (url.searchParams.get('state') !== state) return fail('expired');
  const code = url.searchParams.get('code');
  if (!code)
    return fail(url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed');

  const res = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: `${siteOrigin(request)}/api/auth/google/callback`,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) return fail('failed');
  const { id_token: idToken } = (await res.json()) as { id_token?: string };
  const payload = idToken?.split('.')[1];
  if (!payload) return fail('failed');
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as IdClaims;
  const issuerOk =
    claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issuerOk || claims.aud !== env.GOOGLE_CLIENT_ID || !claims.sub || !claims.email) {
    return fail('failed');
  }
  if (claims.email_verified === false) return fail('unverified');

  const user = await store.upsertUser(
    {
      googleSub: claims.sub,
      email: claims.email,
      name: claims.name ?? '',
      picture: claims.picture ?? '',
    },
    `usr_${randomToken(12)}`,
    now,
  );
  const token = randomToken(32);
  await store.createSession(await sha256(token), user.id, now, now + SESSION_DAYS * 86_400_000);
  const back = new TextDecoder().decode(fromB64url(back64));
  const headers = new Headers({ Location: safeReturn(back), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', setCookie(SESSION_COOKIE, token, SESSION_DAYS * 86_400));
  headers.append('Set-Cookie', setCookie(FLOW_COOKIE, '', 0, '/api/auth'));
  return new Response(null, { status: 302, headers });
}

async function signedIn(request: Request, store: AuthStore, now: number): Promise<User | null> {
  const token = cookie(request, SESSION_COOKIE);
  return token ? store.sessionUser(await sha256(token), now) : null;
}

/** Writes that change an account must come from the app itself, not another site's form. */
const fromApp = (request: Request) =>
  request.headers.get('Content-Type')?.startsWith('application/json') ?? false;

/**
 * The account routes, or null for any other path. `path` has /api taken off.
 *   GET    /auth/me                 who is signed in ({enabled, user})
 *   GET    /auth/google[?return=]   sign in
 *   GET    /auth/google/callback
 *   POST   /auth/logout
 *   GET    /me/projects             the plans kept for this person, with their keys
 *   PUT    /me/projects/{id}        keep (or update) one
 *   DELETE /me/projects/{id}        stop keeping one
 */
export async function handleAuth(
  request: Request,
  path: string,
  env: AuthEnv,
  store: AuthStore | null,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Response | null> {
  if (!path.startsWith('/auth/') && !path.startsWith('/me/')) return null;
  const method = request.method;
  if (path === '/auth/me' && method === 'GET') {
    if (!enabled(env) || !store) return json({ enabled: false, user: null });
    const user = await signedIn(request, store, now);
    return json({
      enabled: true,
      user: user && { email: user.email, name: user.name, picture: user.picture },
    });
  }
  if (!store) return json({ error: 'sign-in is not set up' }, 404);
  if (path === '/auth/google' && method === 'GET') return start(request, env);
  if (path === '/auth/google/callback' && method === 'GET') {
    return callback(request, env, store, fetcher, now);
  }
  if (path === '/auth/logout' && method === 'POST') {
    const token = cookie(request, SESSION_COOKIE);
    if (token) await store.deleteSession(await sha256(token));
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie(SESSION_COOKIE, '', 0) });
  }

  const user = await signedIn(request, store, now);
  if (!user) return json({ error: 'not signed in' }, 401);
  const secret = env.KEYS_SECRET ?? '';
  if (path === '/me/projects' && method === 'GET') {
    const kept = await store.listProjects(user.id);
    const projects = await Promise.all(
      kept.map(async (p) => ({
        id: p.projectId,
        name: p.name,
        ownerKey: await unseal(secret, p.ownerKey),
        editKey: await unseal(secret, p.editKey),
        sample: p.sample,
        updatedAt: p.updatedAt,
      })),
    );
    return json({ projects });
  }
  const m = path.match(/^\/me\/projects\/([a-z0-9][a-z0-9_-]{0,63})$/);
  if (m?.[1] && method === 'PUT') {
    if (!fromApp(request)) return json({ error: 'expected JSON' }, 415);
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      ownerKey?: unknown;
      editKey?: unknown;
      sample?: unknown;
    } | null;
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    if (!body || !str(body.name, 200)) return json({ error: 'name required' }, 400);
    const kept = await store.listProjects(user.id);
    if (kept.length >= MAX_PROJECTS && !kept.some((p) => p.projectId === m[1])) {
      return json({ error: 'too many plans kept' }, 409);
    }
    await store.putProject(user.id, {
      projectId: m[1],
      name: str(body.name, 200),
      ownerKey: await seal(secret, str(body.ownerKey, 200)),
      editKey: await seal(secret, str(body.editKey, 200)),
      sample: body.sample === true,
      updatedAt: now,
    });
    return json({ ok: true });
  }
  if (m?.[1] && method === 'DELETE') {
    if (!fromApp(request)) return json({ error: 'expected JSON' }, 415);
    await store.deleteProject(user.id, m[1]);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

// ------------------------------------------------------------------------ D1

interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  picture: string;
}

const userOf = (r: UserRow): User => ({
  id: r.id,
  googleSub: r.google_sub,
  email: r.email,
  name: r.name,
  picture: r.picture,
});

export function d1Store(db: D1Database): AuthStore {
  return {
    async upsertUser(u, newId, now) {
      await db
        .prepare(
          `INSERT INTO users (id, google_sub, email, name, picture, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (google_sub) DO UPDATE SET email = ?3, name = ?4, picture = ?5`,
        )
        .bind(newId, u.googleSub, u.email, u.name, u.picture, now)
        .run();
      const row = await db
        .prepare('SELECT * FROM users WHERE google_sub = ?1')
        .bind(u.googleSub)
        .first<UserRow>();
      if (!row) throw new Error('user not stored');
      return userOf(row);
    },
    async createSession(tokenHash, userId, now, expiresAt) {
      await db
        .prepare(
          'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)',
        )
        .bind(tokenHash, userId, now, expiresAt)
        .run();
    },
    async sessionUser(tokenHash, now) {
      const row = await db
        .prepare(
          `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
           WHERE sessions.token_hash = ?1 AND sessions.expires_at > ?2`,
        )
        .bind(tokenHash, now)
        .first<UserRow>();
      return row ? userOf(row) : null;
    },
    async deleteSession(tokenHash) {
      await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
    },
    async listProjects(userId) {
      const { results } = await db
        .prepare(
          `SELECT project_id, name, owner_key, edit_key, sample, updated_at FROM user_projects
           WHERE user_id = ?1 ORDER BY updated_at DESC`,
        )
        .bind(userId)
        .all<{
          project_id: string;
          name: string;
          owner_key: string;
          edit_key: string;
          sample: number;
          updated_at: number;
        }>();
      return results.map((r) => ({
        projectId: r.project_id,
        name: r.name,
        ownerKey: r.owner_key,
        editKey: r.edit_key,
        sample: r.sample === 1,
        updatedAt: r.updated_at,
      }));
    },
    async putProject(userId, p) {
      // A key once kept isn't lost by a later save from a device that doesn't hold it.
      await db
        .prepare(
          `INSERT INTO user_projects (user_id, project_id, name, owner_key, edit_key, sample, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT (user_id, project_id) DO UPDATE SET
             name = ?3,
             owner_key = CASE WHEN ?4 = '' THEN owner_key ELSE ?4 END,
             edit_key = CASE WHEN ?5 = '' THEN edit_key ELSE ?5 END,
             sample = ?6,
             updated_at = ?7`,
        )
        .bind(userId, p.projectId, p.name, p.ownerKey, p.editKey, p.sample ? 1 : 0, p.updatedAt)
        .run();
    },
    async deleteProject(userId, projectId) {
      await db
        .prepare('DELETE FROM user_projects WHERE user_id = ?1 AND project_id = ?2')
        .bind(userId, projectId)
        .run();
    },
  };
}

/** For tests: the same behaviour in memory. */
export function memoryStore(): AuthStore & { users: Map<string, User> } {
  const users = new Map<string, User>();
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  const projects = new Map<string, Map<string, KeptProject>>();
  return {
    users,
    async upsertUser(u, newId) {
      const found = [...users.values()].find((x) => x.googleSub === u.googleSub);
      const user = { ...u, id: found?.id ?? newId };
      users.set(user.id, user);
      return user;
    },
    async createSession(tokenHash, userId, _now, expiresAt) {
      sessions.set(tokenHash, { userId, expiresAt });
    },
    async sessionUser(tokenHash, now) {
      const s = sessions.get(tokenHash);
      return s && s.expiresAt > now ? (users.get(s.userId) ?? null) : null;
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },
    async listProjects(userId) {
      return [...(projects.get(userId)?.values() ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async putProject(userId, p) {
      const mine = projects.get(userId) ?? new Map<string, KeptProject>();
      const was = mine.get(p.projectId);
      mine.set(p.projectId, {
        ...p,
        ownerKey: p.ownerKey || was?.ownerKey || '',
        editKey: p.editKey || was?.editKey || '',
      });
      projects.set(userId, mine);
    },
    async deleteProject(userId, projectId) {
      projects.get(userId)?.delete(projectId);
    },
  };
}
