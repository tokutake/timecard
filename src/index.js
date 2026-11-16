import { PAGE } from './page.js';
import { currentEmail } from './auth.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

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

// 初回アクセス時に利用者を登録し、users.id を返す
async function ensureUser(db, email) {
  const row = await db
    .prepare(
      'INSERT INTO users (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET email = excluded.email RETURNING id'
    )
    .bind(email, new Date().toISOString())
    .first();
  return row.id;
}

async function getOpenRecord(db, userId) {
  return db
    .prepare(
      'SELECT id, clock_in FROM records WHERE user_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1'
    )
    .bind(userId)
    .first();
}

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // 画面本体は公開（データは含まない）。ログインは Cloudflare Access が担当する
      if (pathname === '/' && method === 'GET') {
        return new Response(PAGE, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      if (pathname.startsWith('/api/')) {
        const email = await currentEmail(request, env);
        if (!email) {
          return json({ error: 'ログインが必要です' }, 401);
        }
        const id = await ensureUser(env.DB, email);
        return await handleApi(request, env, url, { id, email });
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  },
};
