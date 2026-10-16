/**
 * The app each provider uses to start and pay for a charge, with verified
 * store links. Only entries whose store listing was confirmed to belong to the
 * provider (seller matches, or the provider's own site links to it) belong here.
 */
export interface ProviderApp {
  /** App name as listed in the stores; omitted for providers that only take card/QR. */
  name?: string;
  ios?: string;
  android?: string;
  /** Extra context, e.g. "also accepts card via QR". */
  note?: string;
}

// Verified Oct 2026: iOS via Apple's lookup API (seller = operator or parent),
// Android via the Play listing (title/developer), and where reachable the
// operator's own site linking to the listing.
const IOS = (path: string) => `https://apps.apple.com/sg/app/${path}`;
const PLAY = (id: string) => `https://play.google.com/store/apps/details?id=${id}`;

export const PROVIDER_APPS: Readonly<Record<string, ProviderApp>> = {
  sp: { name: "SP: Utilities & EV Charging", ios: IOS("sp-utilities-ev-charging/id596749130"), android: PLAY("sg.com.singaporepower.spservices") },
  "cdg-engie": { name: "CDG ENERGY", ios: IOS("cdg-energy/id6670190438"), android: PLAY("com.cdgengiepilot.evc") },
  shell: { name: "Shell Recharge Asia", ios: IOS("shell-recharge-asia/id6458189524"), android: PLAY("com.zecosystems.shellrechargeasia") },
  chargeplus: { name: "CHARGE+", ios: IOS("charge/id1481750244"), android: PLAY("com.chargeplus.chargeapp") },
  strides: { name: "ChargEco", ios: IOS("chargeco/id1664718768"), android: PLAY("com.strides.chargeco") },
  volt: { name: "Volt EV Charging", ios: IOS("volt-ev-charging/id1606309147"), android: PLAY("com.wanbangauto.keppel") },
  mnl: { name: "EV Charge by MNL", ios: IOS("ev-charge-by-mnl/id1597892677"), android: PLAY("com.mnlasia.cp.app") },
  fastparkncharge: { name: "FastParkNCharge", ios: IOS("fastparkncharge/id6447027292"), android: PLAY("com.mackparking.fpnc") },
  novowatt: { name: "Watt EV Charging", ios: IOS("watt-ev-charging/id1617293408"), android: PLAY("sg.watt.v2.cp.app") },
  greatcharge: { name: "Great Rewards SG", ios: IOS("great-rewards-sg/id1535765536"), android: PLAY("com.shangrila.greatrewards"), note: "or tap a card at the charger" },
  evmobility: { name: "Juice+", ios: IOS("juice/id1572430525"), android: PLAY("com.evct.juiceplus") },
  tesla: { name: "Tesla", ios: IOS("tesla/id582007913"), android: PLAY("com.teslamotors.tesla") },
  ked: { name: "KED", ios: IOS("ked/id6593664370"), android: PLAY("com.ked.chargeapp") },
  cityenergy: { name: "City Energy Go", ios: IOS("city-energy-go/id1615899785"), android: PLAY("com.cityenergygo.app") },
  busways: { name: "BEV", ios: IOS("bev/id1586084485"), android: PLAY("com.busways.ev") },
  wescares: { name: "Wes Cares", ios: IOS("wes-cares/id6468880863"), note: "iPhone only" },
  uniongas: { name: "Union Charge", ios: IOS("union-charge/id6761822514"), android: PLAY("com.lumicharging.unioncharge") },
  eneready: { name: "ENEReady", ios: IOS("eneready/id1612599603"), android: PLAY("com.eneready.ener") },
  iwow: { name: "iCharge.SG", ios: IOS("icharge-sg/id6743070284"), note: "iPhone only" },
  eigen: { note: "Pay by card or QR at the charger" },
};

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
