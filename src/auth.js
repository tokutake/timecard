// Cloudflare Access による認証。
// Access が発行する JWT（Cf-Access-Jwt-Assertion ヘッダー）を RS256 で検証し、
// メールアドレスを取り出す。Worker を直接叩かれても署名が無ければ拒否される。

const enc = new TextEncoder();
const CERT_TTL_MS = 60 * 60 * 1000;
let certCache = { keys: [], fetchedAt: 0 };

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function decodePart(part) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
}

async function fetchKeys(teamDomain) {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access 証明書の取得に失敗しました (${res.status})`);
  const body = await res.json();
  certCache = { keys: body.keys ?? [], fetchedAt: Date.now() };
  return certCache.keys;
}

async function findKey(teamDomain, kid) {
  const fresh = Date.now() - certCache.fetchedAt < CERT_TTL_MS;
  let key = fresh ? certCache.keys.find((k) => k.kid === kid) : undefined;
  if (!key) {
    // 鍵のローテーションに備え、見つからなければ再取得して 1 回だけ探す
    const keys = await fetchKeys(teamDomain);
    key = keys.find((k) => k.kid === kid);
  }
  return key ?? null;
}

// JWT を検証し、成功ならメールアドレスを返す。失敗なら null
export async function verifyAccessJwt(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header;
  let payload;
  try {
    header = decodePart(parts[0]);
    payload = decodePart(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;
  if (payload.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) return null;
  if (![].concat(payload.aud ?? []).includes(env.CF_ACCESS_AUD)) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  if (typeof payload.email !== 'string' || payload.email === '') return null;

  const jwk = await findKey(env.CF_ACCESS_TEAM_DOMAIN, header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`)
  );
  return valid ? payload.email : null;
}

// 現在のリクエストの利用者メールアドレス。未認証なら null
export async function currentEmail(request, env) {
  const url = new URL(request.url);
  // ローカル開発専用：localhost でのみ DEV_USER_EMAIL を利用者として扱う
  if (env.DEV_USER_EMAIL && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return env.DEV_USER_EMAIL;
  }
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    throw new Error('CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD が設定されていません');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  return verifyAccessJwt(token, env);
}
