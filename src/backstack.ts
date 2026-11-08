/**
 * Makes the system Back button (Android, browser) close the app's UI one layer
 * at a time instead of leaving the app. Each open layer (station, settings,
 * a menu, a panel) owns one history entry: Back pops it and its close()
 * runs; closing a layer from the UI removes its entry silently.
 *
 * history.go() is asynchronous, so pushes/replaces requested while a silent
 * back is in flight are queued until it lands.
 */
interface Layer {
  name: string;
  close: () => void;
}

const layers: Layer[] = [];
let ignorePop = false;
let settling = false;
const queue: Array<() => void> = [];

function run(fn: () => void): void {
  if (settling) queue.push(fn);
  else fn();
}

function silentBack(n: number): void {
  run(() => {
    settling = true;
    ignorePop = true;
    history.go(-n);
  });
}

export function hasLayer(name: string): boolean {
  return layers.some((l) => l.name === name);
}

/** True while a silent back is landing (hash changes then are ours, not the user's). */
export function isSettling(): boolean {
  return settling;
}

/** Registers an open layer (no-op if it's already open). `url` defaults to the current one. */
export function openLayer(name: string, close: () => void, url?: string): void {
  if (hasLayer(name)) return;
  layers.push({ name, close });
  run(() => history.pushState({ chargeitLayer: name }, "", url ?? location.href));
}

/** The UI closed this layer itself: drop it (and anything opened on top of it) without leaving the app. */
export function closeLayer(name: string): void {
  const i = layers.findIndex((l) => l.name === name);
  if (i < 0) return;
  const removed = layers.splice(i);
  for (const l of removed.slice(1).reverse()) l.close();
  silentBack(removed.length);
}

/** Closes everything opened on top of `name`, keeping `name` itself. */
export function closeAbove(name: string): void {
  const i = layers.findIndex((l) => l.name === name);
  if (i < 0 || i === layers.length - 1) return;
  const removed = layers.splice(i + 1);
  for (const l of removed.reverse()) l.close();
  silentBack(removed.length);
}

/** Replaces the current entry's URL (e.g. switching station), after any silent back lands. */
export function replaceUrl(url: string): void {
  run(() => history.replaceState(history.state, "", url));
}

window.addEventListener("popstate", () => {
  if (ignorePop) {
    ignorePop = false;
    settling = false;
    for (const fn of queue.splice(0)) fn();
    return;
  }
  layers.pop()?.close();
});
