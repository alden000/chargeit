/**
 * The app each provider uses to start and pay for a charge, with verified
 * store links. Only entries whose store listing was confirmed to belong to the
 * provider (seller matches, or the provider's own site links to it) belong here.
 */
export interface ProviderApp {
  name: string;
  ios?: string;
  android?: string;
  /** Extra context, e.g. "also accepts card via QR". */
  note?: string;
}

export const PROVIDER_APPS: Readonly<Record<string, ProviderApp>> = {};

const STORE_HOSTS = new Set(["apps.apple.com", "play.google.com"]);

/** Guards against a malformed entry ever producing a non-store link. */
export function safeStoreUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && STORE_HOSTS.has(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

export type Platform = "ios" | "android" | "other";

export function detectPlatform(ua = navigator.userAgent, touch = navigator.maxTouchPoints): Platform {
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && touch > 1)) return "ios";
  return "other";
}

/** Store links to show for this platform: the matching store first, or both on desktop. */
export function storeLinks(app: ProviderApp, platform: Platform): Array<{ label: string; url: string }> {
  const ios = safeStoreUrl(app.ios);
  const android = safeStoreUrl(app.android);
  if (platform === "ios") return ios ? [{ label: "App Store", url: ios }] : [];
  if (platform === "android") return android ? [{ label: "Google Play", url: android }] : [];
  return [ios ? { label: "App Store", url: ios } : null, android ? { label: "Google Play", url: android } : null].filter((x): x is { label: string; url: string } => !!x);
}
