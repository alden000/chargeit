// Renders PWA icons from the SVG templates using the Playwright Chromium.
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { iconSvg } from "./icon-template.mjs";

const out = new URL("../public/icons/", import.meta.url);
const jobs = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "maskable-512.png", size: 512, maskable: true },
  { file: "maskable-192.png", size: 192, maskable: true },
  { file: "apple-touch-icon.png", size: 180, maskable: true },
];

await writeFile(new URL("icon.svg", out), iconSvg());
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
for (const j of jobs) {
  await page.setViewportSize({ width: j.size, height: j.size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:${j.size}px;height:${j.size}px;display:block}</style>${iconSvg({ maskable: j.maskable })}`,
  );
  await page.screenshot({ path: new URL(j.file, out).pathname, omitBackground: true });
  console.log("wrote", j.file);
}
await browser.close();
