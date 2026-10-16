// Builds the square app-icon SVG (mark on an ink tile). `maskable` = full bleed, mark shrunk into the 80% safe zone.
export function iconSvg({ maskable = false } = {}) {
  const scale = maskable ? 0.74 : 0.86;
  const t = (512 * (1 - scale)) / 2;
  const radius = maskable ? 0 : 116;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="0.3" cy="0.2" r="1">
      <stop offset="0" stop-color="#1A2542"/><stop offset="0.6" stop-color="#0C1324"/><stop offset="1" stop-color="#070B16"/>
    </radialGradient>
    <radialGradient id="glow" cx="0.5" cy="0.45" r="0.5">
      <stop offset="0" stop-color="#1CE8B5" stop-opacity="0.35"/><stop offset="1" stop-color="#1CE8B5" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="pin" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#5BFFD6"/><stop offset="0.55" stop-color="#1CE8B5"/><stop offset="1" stop-color="#00B48C"/>
    </linearGradient>
    <mask id="cut"><rect width="512" height="512" fill="#fff"/><path d="M284 112 190 246h62l-22 108 98-142h-62l18-100z" fill="#000"/></mask>
  </defs>
  <rect width="512" height="512" rx="${radius}" fill="url(#bg)"/>
  <g transform="translate(${t} ${t + 10 * scale}) scale(${scale})">
    <circle cx="256" cy="230" r="230" fill="url(#glow)"/>
    <path mask="url(#cut)" fill="url(#pin)" d="M256 446c-18-26-150-158-150-226a150 150 0 0 1 300 0c0 68-132 200-150 226z"/>
    <circle cx="392" cy="104" r="26" fill="#FF4F7B"/>
  </g>
</svg>`;
}
