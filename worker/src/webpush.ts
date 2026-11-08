/**
 * Web Push with nothing but WebCrypto: VAPID authentication (RFC 8292) and
 * aes128gcm payload encryption (RFC 8291 / RFC 8188).
 *
 * The VAPID key pair is the Worker secret VAPID_JWK (a P-256 private JWK),
 * created by .github/workflows/setup-push-keys.yml and never stored anywhere else.
 */

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string; // browser's public key, base64url, 65 bytes uncompressed
  auth: string; // browser's auth secret, base64url, 16 bytes
}

export type PushResult = "sent" | "gone" | "failed";

/** Push services we deliver to; anything else is refused (no requests to arbitrary hosts). */
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com"];
const PUSH_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

export function isPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port) return false;
  return PUSH_HOSTS.includes(u.hostname) || PUSH_SUFFIXES.some((s) => u.hostname.endsWith(s));
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const enc = new TextEncoder();
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** Encrypts a payload for one subscription (single aes128gcm record). */
export async function encryptPayload(sub: Pick<PushSubscriptionKeys, "p256dh" | "auth">, payload: Uint8Array): Promise<Uint8Array> {
  const uaPublic = unb64url(sub.p256dh);
  const authSecret = unb64url(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("bad subscription keys");
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  // Cloudflare's type definitions spell this field `$public`; the runtime (per WebCrypto) reads `public`.
  const ecdh = { name: "ECDH", public: uaKey } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0];
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(payload, new Uint8Array([2])); // 0x02: last (and only) record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));

  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

export interface Vapid {
  publicKey: string; // base64url, 65 bytes uncompressed
  sign(audience: string): Promise<string>; // JWT
}

/** Loads the VAPID key pair from its JWK; the subject identifies who runs the sender. */
export async function loadVapid(jwkJson: string, subject: string): Promise<Vapid> {
  const jwk = JSON.parse(jwkJson) as JsonWebKey;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) throw new Error("VAPID_JWK is not a P-256 private key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const publicKey = b64url(concat(new Uint8Array([4]), unb64url(jwk.x), unb64url(jwk.y)));
  const head = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  return {
    publicKey,
    async sign(audience) {
      const claims = b64url(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
      const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));
      return `${head}.${claims}.${b64url(sig)}`;
    },
  };
}

/** Sends one push. "gone" means the subscription no longer exists and should be forgotten. */
export async function sendPush(vapid: Vapid, sub: PushSubscriptionKeys, payload: unknown, opts: { ttl?: number; topic?: string } = {}): Promise<PushResult> {
  if (!isPushEndpoint(sub.endpoint)) return "gone";
  try {
    const body = await encryptPayload(sub, enc.encode(JSON.stringify(payload)));
    const jwt = await vapid.sign(new URL(sub.endpoint).origin);
    const headers: Record<string, string> = {
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(opts.ttl ?? 600),
      Urgency: "high",
    };
    if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
    const res = await fetch(sub.endpoint, { method: "POST", headers, body });
    void res.body?.cancel();
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "sent" : "failed";
  } catch (err) {
    console.warn("push failed:", String(err));
    return "failed";
  }
}
