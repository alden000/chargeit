const rm = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

export const reducedMotion = (): boolean => !!rm?.matches;

/** A tiny haptic tick on devices that support it. */
export function haptic(ms = 8): void {
  try {
    const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (!reducedMotion() && (!ua || ua.hasBeenActive)) navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}

/** Animates a number in an element from its current value to `to`. */
export function countTo(el: HTMLElement, to: number, ms = 600): void {
  const from = Number(el.dataset.value ?? el.textContent ?? 0) || 0;
  el.dataset.value = String(to);
  if (reducedMotion() || from === to) {
    el.textContent = String(to);
    return;
  }
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 4);
    el.textContent = String(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Runs a DOM update inside a View Transition where supported. */
export function withViewTransition(update: () => void): Promise<void> {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { updateCallbackDone: Promise<void> } };
  if (!reducedMotion() && typeof doc.startViewTransition === "function") {
    return doc.startViewTransition(update).updateCallbackDone.catch(() => undefined);
  }
  update();
  return Promise.resolve();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
