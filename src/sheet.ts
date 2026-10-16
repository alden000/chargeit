import { haptic, reducedMotion } from "./motion.ts";

export type Snap = "peek" | "half" | "full";
const ORDER: Snap[] = ["peek", "half", "full"];

const PEEK_PX = 168;
const STIFFNESS = 380;
const DAMPING = 34;
const FLING_VELOCITY = 0.6; // px/ms

/**
 * Draggable bottom sheet with three snap points and spring physics.
 * Position is the sheet's visible height in px (0 = hidden).
 */
export class BottomSheet {
  snap: Snap = "peek";
  private y = 0; // visible height
  private v = 0; // px/s
  private target = 0;
  private raf = 0;
  private drag: { id: number; startY: number; startH: number; lastY: number; lastT: number; vel: number; moved: boolean } | null = null;
  private listeners = new Set<(snap: Snap, visible: number) => void>();

  constructor(
    private el: HTMLElement,
    private scrollers: () => HTMLElement[],
  ) {
    el.addEventListener("pointerdown", (e) => this.onDown(e));
    // Track moves on the window: a mouse that leaves the sheet mid-drag (before
    // capture kicks in) must not drop the gesture. Touch is implicitly captured.
    window.addEventListener("pointermove", (e) => this.onMove(e), { passive: false });
    window.addEventListener("pointerup", (e) => this.onUp(e));
    window.addEventListener("pointercancel", (e) => this.onUp(e, true));
    // In "full", content scrolls natively (touch-action: pan-y). When it's already
    // at the top and the finger pulls down, claim the gesture before the browser
    // starts a scroll, so it collapses the sheet instead of firing pointercancel.
    let touchY = 0;
    el.addEventListener("touchstart", (e) => (touchY = e.touches[0]?.clientY ?? 0), { passive: true });
    el.addEventListener(
      "touchmove",
      (e) => {
        if (this.snap !== "full" || !e.cancelable) return;
        const scroller = this.scrollers().find((s) => s.contains(e.target as Node));
        const dy = (e.touches[0]?.clientY ?? 0) - touchY;
        if (!scroller || (scroller.scrollTop <= 0 && dy > 0) || this.drag?.moved) e.preventDefault();
      },
      { passive: false },
    );
    el.addEventListener("keydown", (e) => {
      if (!(e.target as HTMLElement).closest(".sheet__grip, .sheet__head")) return;
      if (e.key === "ArrowUp") this.step(1);
      else if (e.key === "ArrowDown") this.step(-1);
    });
    const grip = el.querySelector<HTMLElement>(".sheet__grip");
    if (grip) {
      grip.tabIndex = 0;
      grip.setAttribute("role", "button");
      grip.setAttribute("aria-label", "Resize panel");
      grip.addEventListener("click", () => this.step(this.snap === "full" ? -2 : 1));
    }
    window.addEventListener("resize", () => this.to(this.snap, false));
    this.y = 0;
    this.apply();
  }

  onChange(fn: (snap: Snap, visible: number) => void): void {
    this.listeners.add(fn);
  }

  heightFor(snap: Snap): number {
    const H = this.el.parentElement?.clientHeight ?? window.innerHeight;
    if (snap === "peek") return Math.min(PEEK_PX, H * 0.4);
    if (snap === "half") return Math.round(H * 0.5);
    // Full: tuck neatly under the brand row so nothing is half-covered.
    const row = document.querySelector(".topbar__row")?.getBoundingClientRect();
    return Math.round(H - Math.max(64, (row?.bottom ?? 56) + 10));
  }

  /** Visible height once the current animation settles. */
  get settledHeight(): number {
    return this.heightFor(this.snap);
  }

  to(snap: Snap, animate = true): void {
    const changed = snap !== this.snap;
    this.snap = snap;
    this.el.dataset.snap = snap;
    this.target = this.heightFor(snap);
    if (changed) haptic(6);
    if (!animate || reducedMotion() || this.isDesktop()) {
      this.y = this.target;
      this.v = 0;
      this.apply();
      return;
    }
    this.run();
  }

  step(dir: number): void {
    const i = Math.max(0, Math.min(ORDER.length - 1, ORDER.indexOf(this.snap) + dir));
    this.to(ORDER[i]);
  }

  private isDesktop(): boolean {
    return window.innerWidth >= 820;
  }

  private run(): void {
    cancelAnimationFrame(this.raf);
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const force = -STIFFNESS * (this.y - this.target) - DAMPING * this.v;
      this.v += force * dt;
      this.y += this.v * dt;
      if (Math.abs(this.v) < 4 && Math.abs(this.y - this.target) < 0.5) {
        this.y = this.target;
        this.v = 0;
        this.apply();
        return;
      }
      this.apply();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private apply(): void {
    const H = this.el.parentElement?.clientHeight ?? window.innerHeight;
    if (!this.isDesktop()) {
      const offset = Math.round(H - this.y);
      this.el.style.transform = `translate3d(0, ${offset}px, 0)`;
      // The sheet is full-height and slid down; pad its bottom by the hidden part
      // so scrollable content always ends at the screen edge, never below it.
      this.el.style.paddingBottom = `${Math.max(0, offset)}px`;
    } else {
      this.el.style.paddingBottom = "";
    }
    const visible = this.isDesktop() ? 0 : Math.max(0, this.y);
    document.documentElement.style.setProperty("--sheet-visible", `${Math.min(visible, this.heightFor("half"))}px`);
    for (const fn of this.listeners) fn(this.snap, visible);
  }

  // ── Dragging ──────────────────────────────────────────────────────────

  private onDown(e: PointerEvent): void {
    if (this.isDesktop() || (e.pointerType === "mouse" && e.button !== 0)) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea")) return;
    this.drag = { id: e.pointerId, startY: e.clientY, startH: this.y, lastY: e.clientY, lastT: performance.now(), vel: 0, moved: false };
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.startY;
    if (!d.moved) {
      if (Math.abs(dy) < 6) return;
      // Let the inner list scroll when it can; only take over at its edges.
      const scroller = this.scrollers().find((s) => s.contains(e.target as Node));
      if (scroller && this.snap === "full") {
        const atTop = scroller.scrollTop <= 0;
        if (!(atTop && dy > 0)) {
          this.drag = null;
          return;
        }
      }
      d.moved = true;
      cancelAnimationFrame(this.raf);
      this.el.setPointerCapture(e.pointerId);
    }
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    d.vel = 0.8 * ((e.clientY - d.lastY) / dt) + 0.2 * d.vel;
    d.lastY = e.clientY;
    d.lastT = now;
    const min = this.heightFor("peek");
    const max = this.heightFor("full");
    let h = d.startH - dy;
    // Rubber-band beyond the ends.
    if (h > max) h = max + (h - max) * 0.25;
    if (h < min) h = min - (min - h) * 0.35;
    this.y = h;
    this.v = 0;
    this.apply();
    e.preventDefault();
  }

  private onUp(e: PointerEvent, cancelled = false): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (!d.moved) return;
    if (cancelled) d.vel = 0; // browser took over the gesture: settle, never fling
    // Swallow the click that follows a drag.
    const swallow = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    this.el.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => this.el.removeEventListener("click", swallow, { capture: true }), 50);

    const vel = -d.vel; // up = positive
    let snap: Snap;
    if (Math.abs(vel) > FLING_VELOCITY) {
      const i = ORDER.indexOf(this.snap);
      const cur = ORDER.reduce((best, s) => (Math.abs(this.heightFor(s) - this.y) < Math.abs(this.heightFor(best) - this.y) ? s : best), this.snap);
      const base = vel > 0 ? Math.max(i, ORDER.indexOf(cur)) : Math.min(i, ORDER.indexOf(cur));
      snap = ORDER[Math.max(0, Math.min(2, base + (vel > 0 ? 1 : -1)))];
      if (vel > 0 && this.heightFor(snap) < this.y) snap = "full";
      if (vel < 0 && this.heightFor(snap) > this.y) snap = "peek";
    } else {
      snap = ORDER.reduce((best, s) => (Math.abs(this.heightFor(s) - this.y) < Math.abs(this.heightFor(best) - this.y) ? s : best), "peek" as Snap);
    }
    this.v = vel * 1000 * 0.5;
    this.to(snap);
    this.v = vel * 1000 * 0.5; // carry the fling into the spring
    if (!reducedMotion()) this.run();
  }
}
