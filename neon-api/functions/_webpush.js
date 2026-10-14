/** _webpush.js : Web Push for Cloudflare Workers using only WebCrypto (no libraries).
 *  - Payload encryption: RFC 8291 + RFC 8188 "aes128gcm" (one record).
 *  - Sender identity: RFC 8292 VAPID (ES256 JWT), so Apple, Google and Mozilla accept it.
 */
const te = new TextEncoder();

export const b64u = {
  enc(bytes) {
    let s = ''; const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/'); const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    const bin = atob(s + pad); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0); const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** Encrypts bytes for one browser subscription (keys.p256dh, keys.auth as base64url). */
export async function encryptPayload(p256dhB64, authB64, payload) {
  const uaPublic = b64u.dec(p256dhB64);
  const authSecret = b64u.dec(authB64);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  // RFC 8291 section 3.4
  const prkKey = await hmac(authSecret, shared);
  const ikm = (await hmac(prkKey, concat(te.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/** VAPID Authorization header value for an endpoint. jwk = private P-256 JWK {x,y,d}. */
export async function vapidHeader(endpoint, jwk, publicKeyB64, subject) {
  const aud = new URL(endpoint).origin;
  const h = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u.enc(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(h + '.' + p)));
  return 'vapid t=' + h + '.' + p + '.' + b64u.enc(sig) + ', k=' + publicKeyB64;
}

/** Sends one push. Returns { ok, status, gone } (gone = the browser unsubscribed; delete it). */
export async function sendWebPush(sub, payloadObj, opts) {
  const body = await encryptPayload(sub.p256dh, sub.auth, te.encode(JSON.stringify(payloadObj)));
  let r;
  try {
    r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(sub.endpoint, opts.jwk, opts.publicKey, opts.subject || 'mailto:dane@neongiantmoving.com'),
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: String(opts.ttl || 86400), Urgency: opts.urgency || 'normal',
        ...(opts.topic ? { Topic: opts.topic } : {}),
      },
      body, signal: AbortSignal.timeout(10000),
    });
  } catch (e) { return { ok: false, status: 0, gone: false, error: String((e && e.name) || e) }; }
  const ok = r.status >= 200 && r.status < 300;
  return { ok, status: r.status, gone: r.status === 404 || r.status === 410, error: ok ? '' : (await r.text()).slice(0, 160) };
}
