import { registerSW } from "virtual:pwa-register";

/** Registers the service worker and surfaces "new version ready" to the UI. */
export function registerPwa(onNeedRefresh: (update: () => void) => void): void {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  const update = registerSW({
    onNeedRefresh() {
      onNeedRefresh(() => void update(true));
    },
    onRegisteredSW(_url, reg) {
      // Check for a new deploy every 30 minutes while the app is open.
      if (reg) setInterval(() => void reg.update(), 30 * 60 * 1000);
    },
  });
}
