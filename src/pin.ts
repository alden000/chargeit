import { BOLT } from "./icons.ts";
import type { Summary } from "./model.ts";

/** Ring-style availability marker shared by the map, list and detail views. */
export function pinHtml(sum: Pick<Summary, "free" | "busy" | "offline" | "state" | "hasDC">, label?: string): string {
  const total = sum.free + sum.busy + sum.offline || 1;
  const p = sum.free / total;
  const q = sum.busy / total;
  const text = label ?? (sum.state === "offline" ? "–" : String(sum.free));
  return `<span class="pin pin--${sum.state}" style="--p:${p.toFixed(3)};--q:${q.toFixed(3)}" aria-hidden="true">
    <span class="pin__ring"></span><span class="pin__core"></span>
    <span class="pin__label">${text}</span>${sum.hasDC ? `<span class="pin__bolt">${BOLT}</span>` : ""}
  </span>`;
}

export function boltsHtml(tier: number): string {
  let s = `<span class="bolts" aria-hidden="true">`;
  for (let i = 1; i <= 3; i++) s += `<span class="${i <= tier ? "" : "off"}">${BOLT}</span>`;
  return `${s}</span>`;
}
