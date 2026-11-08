import { describe, expect, it } from "vitest";
// @ts-expect-error node types aren't installed for the worker-side tests; vitest runs on Node
import { createECDH, randomBytes } from "node:crypto";
// @ts-expect-error no types for http_ece (reference implementation of RFC 8188)
import ece from "http_ece";
import { b64url, encryptPayload, isPushEndpoint, loadVapid, unb64url } from "../../worker/src/webpush.ts";

describe("web push", () => {
  it("encrypts payloads the reference implementation can decrypt (RFC 8291)", async () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = randomBytes(16);
    const body = await encryptPayload({ p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) }, new TextEncoder().encode('{"title":"Free now"}'));
    const plain = ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ua, authSecret: auth });
    expect(plain.toString()).toBe('{"title":"Free now"}');
  });

  it("signs VAPID JWTs that verify with the public key (ES256)", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const vapid = await loadVapid(JSON.stringify(jwk), "https://chargeit.wwweeeiii.com");
    expect(unb64url(vapid.publicKey)).toHaveLength(65);
    const jwt = await vapid.sign("https://fcm.googleapis.com");
    const [h, c, s] = jwt.split(".");
    const claims = JSON.parse(new TextDecoder().decode(unb64url(c)));
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://chargeit.wwweeeiii.com" });
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, unb64url(s), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });

  it("only talks to real push services", () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/QOx")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushEndpoint("https://wns2-sg2p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isPushEndpoint("https://evil.example/fcm.googleapis.com")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isPushEndpoint("not a url")).toBe(false);
  });
});
