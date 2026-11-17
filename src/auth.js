// メールアドレスとパスワードによる認証。
// - パスワードは PBKDF2-SHA256（ランダムな salt 付き）でハッシュ化して保存する
// - ログイン成功時にランダムなセッショントークンを発行し、ハッシュだけを DB に保存する
// - 連続して失敗したアカウントは一定時間ロックする

const enc = new TextEncoder();
export const ITERATIONS = 100000; // Workers の PBKDF2 上限
const SESSION_DAYS = 30;
export const COOKIE_NAME = 'tc_session';
export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

function safeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

// stored が null（存在しないアカウント）でも同じ計算を行い、応答時間から存在を推測されにくくする
export async function verifyPassword(password, stored) {
  if (!stored) {
    await pbkdf2(password, new Uint8Array(16), ITERATIONS);
    return false;
  }
  const [, iterStr, saltHex, hashHex] = stored.split('$');
  const hash = await pbkdf2(password, fromHex(saltHex), Number(iterStr));
  return safeEqualBytes(hash, fromHex(hashHex));
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function createSession(db, userId) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), userId, expires)
    .run();
  return token;
}

export function readSessionToken(request) {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

// セッションから利用者を取得。無効なら null
export async function userFromRequest(request, db) {
  const token = readSessionToken(request);
  if (!token) return null;
  return db
    .prepare(
      'SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
    )
    .bind(await sha256Hex(token), new Date().toISOString())
    .first();
}

export async function deleteSession(request, db) {
  const token = readSessionToken(request);
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

export function cookieFor(request, value, maxAgeSeconds) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (new URL(request.url).protocol === 'https:') parts.push('Secure');
  return parts.join('; ');
}

export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;
