import { PAGE } from './page.js';
import {
  LOCK_MINUTES,
  MAX_FAILURES,
  SESSION_MAX_AGE,
  cookieFor,
  createSession,
  deleteSession,
  hashPassword,
  userFromRequest,
  verifyPassword,
} from './auth.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 日本時間(JST = UTC+9)の月初・翌月初を UTC の ISO 文字列で返す
function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month ?? '');
  if (!m) return null;
  const y = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const start = new Date(Date.UTC(y, mon - 1, 1) - JST_OFFSET_MS);
  const end = new Date(Date.UTC(y, mon, 1) - JST_OFFSET_MS);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function getOpenRecord(db, userId) {
  return db
    .prepare(
      'SELECT id, clock_in FROM records WHERE user_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1'
    )
    .bind(userId)
    .first();
}

// ログイン後に使う API
async function handleApi(request, env, url, user) {
  const { pathname } = url;
  const method = request.method;
  const db = env.DB;
  const uid = user.id;

  if (pathname === '/api/me' && method === 'GET') {
    return json({ email: user.email });
  }

  if (pathname === '/api/status' && method === 'GET') {
    const open = await getOpenRecord(db, uid);
    return json({ working: !!open, since: open?.clock_in ?? null, id: open?.id ?? null });
  }

  if (pathname === '/api/clock-in' && method === 'POST') {
    if (await getOpenRecord(db, uid)) {
      return json({ error: 'すでに出勤中です' }, 409);
    }
    const now = new Date().toISOString();
    const res = await db
      .prepare('INSERT INTO records (clock_in, user_id) VALUES (?, ?) RETURNING id, clock_in, clock_out')
      .bind(now, uid)
      .first();
    return json(res, 201);
  }

  if (pathname === '/api/clock-out' && method === 'POST') {
    const open = await getOpenRecord(db, uid);
    if (!open) {
      return json({ error: '出勤中の記録がありません' }, 409);
    }
    const now = new Date().toISOString();
    const res = await db
      .prepare(
        'UPDATE records SET clock_out = ? WHERE id = ? AND user_id = ? RETURNING id, clock_in, clock_out'
      )
      .bind(now, open.id, uid)
      .first();
    return json(res);
  }

  if (pathname === '/api/records' && method === 'GET') {
    const range = monthRange(url.searchParams.get('month'));
    if (!range) return json({ error: 'month は YYYY-MM 形式で指定してください' }, 400);
    const { results } = await db
      .prepare(
        'SELECT id, clock_in, clock_out FROM records WHERE user_id = ? AND clock_in >= ? AND clock_in < ? ORDER BY clock_in ASC'
      )
      .bind(uid, range.start, range.end)
      .all();
    return json({ records: results });
  }

  const delMatch = /^\/api\/records\/(\d+)$/.exec(pathname);
  if (delMatch && method === 'DELETE') {
    const res = await db
      .prepare('DELETE FROM records WHERE id = ? AND user_id = ?')
      .bind(Number(delMatch[1]), uid)
      .run();
    if (res.meta.changes === 0) {
      return json({ error: '記録が見つかりません' }, 404);
    }
    return json({ ok: true });
  }

  return json({ error: 'Not Found' }, 404);
}

async function handleRegister(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'リクエストが不正です' }, 400);
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = body.password;

  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return json({ error: 'メールアドレスの形式が正しくありません' }, 400);
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return json({ error: 'パスワードは 8 文字以上 128 文字以下にしてください' }, 400);
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    return json({ error: 'このメールアドレスは登録済みです' }, 409);
  }

  const hash = await hashPassword(password);
  const row = await env.DB
    .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?) RETURNING id')
    .bind(email, hash, new Date().toISOString())
    .first();

  const token = await createSession(env.DB, row.id);
  return json({ ok: true, email }, 201, {
    'Set-Cookie': cookieFor(request, token, SESSION_MAX_AGE),
  });
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'リクエストが不正です' }, 400);
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const db = env.DB;
  const now = new Date();

  const user = await db
    .prepare('SELECT id, email, password_hash, failed_count, locked_until FROM users WHERE email = ?')
    .bind(email)
    .first();

  if (user?.locked_until && user.locked_until > now.toISOString()) {
    return json({ error: '試行回数が多すぎます。しばらくしてから再度お試しください' }, 429);
  }

  const ok = await verifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok) {
    if (user) {
      const failures = user.failed_count + 1;
      const locked =
        failures >= MAX_FAILURES
          ? new Date(now.getTime() + LOCK_MINUTES * 60 * 1000).toISOString()
          : null;
      await db
        .prepare('UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?')
        .bind(failures >= MAX_FAILURES ? 0 : failures, locked, user.id)
        .run();
    }
    return json({ error: 'メールアドレスまたはパスワードが違います' }, 401);
  }

  await db
    .prepare('UPDATE users SET failed_count = 0, locked_until = NULL WHERE id = ?')
    .bind(user.id)
    .run();
  const token = await createSession(db, user.id);
  return json({ ok: true, email: user.email }, 200, {
    'Set-Cookie': cookieFor(request, token, SESSION_MAX_AGE),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      if (pathname === '/' && method === 'GET') {
        return new Response(PAGE, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      if (pathname === '/api/register' && method === 'POST') {
        return await handleRegister(request, env);
      }

      if (pathname === '/api/login' && method === 'POST') {
        return await handleLogin(request, env);
      }

      if (pathname === '/api/logout' && method === 'POST') {
        await deleteSession(request, env.DB);
        return json({ ok: true }, 200, { 'Set-Cookie': cookieFor(request, '', 0) });
      }

      if (pathname.startsWith('/api/')) {
        const user = await userFromRequest(request, env.DB);
        if (!user) {
          return json({ error: 'ログインが必要です' }, 401);
        }
        return await handleApi(request, env, url, user);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  },
};
