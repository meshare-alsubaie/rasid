/**
 * Render the app icon at the sizes a PWA install needs.
 *
 * The mark is the Season Bar reduced to a glyph: lanes, one live window, and
 * the hairline for today crossing them. Playwright is already a dependency for
 * the collector's rendered sources, so the icons are produced from the same SVG
 * the design uses rather than pulled in as binary blobs nobody can edit.
 *
 *   npm run icons
 */
import { chromium } from "playwright";

const SIZES = [192, 512];

/** Content sits inside the middle 60% so a maskable crop cannot cut it. */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#101720"/>
  <g stroke-linecap="round">
    <line x1="140" y1="196" x2="372" y2="196" stroke="#7C8794" stroke-width="16"/>
    <line x1="140" y1="256" x2="372" y2="256" stroke="#7C8794" stroke-width="16"/>
    <line x1="140" y1="316" x2="372" y2="316" stroke="#7C8794" stroke-width="16"/>
    <line x1="212" y1="256" x2="330" y2="256" stroke="#0B6E4F" stroke-width="16"/>
  </g>
  <line x1="256" y1="150" x2="256" y2="362" stroke="#F8FAFB" stroke-width="10"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0">${svg.replace('viewBox="0 0 512 512"', `width="${size}" height="${size}" viewBox="0 0 512 512"`)}</body>`,
  );
  await page.screenshot({ path: `public/icon-${size}.png`, omitBackground: false });
  console.log(`public/icon-${size}.png`);
}
await browser.close();
