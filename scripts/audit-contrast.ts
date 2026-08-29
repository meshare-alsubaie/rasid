/**
 * Measure text contrast on every screen, against the built site.
 *
 * Spec acceptance criterion 8.7 asks for 4.5:1. A number measured once and then
 * written into a README is a claim, not a guarantee, so this runs the
 * measurement instead: it starts the preview server, walks all four screens,
 * composites every translucent background layer properly, and exits non-zero if
 * a single run of text falls short.
 *
 * SVG text is included on purpose. The Season Bar's labels live there, and an
 * audit that skipped them would have passed while the "?" on the dark panel sat
 * at 4.0:1 — which is exactly how that one was found.
 *
 * The page code is a string rather than a function. tsx compiles a passed
 * function with a `__name` helper that does not exist inside the browser, and
 * this file is checked without the DOM lib, so `document` would not typecheck
 * here either. A string sidesteps both without weakening anything.
 *
 *   npm run build && npm run audit:contrast
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright";

const PORT = 4178;
const URL = `http://localhost:${PORT}/`;

const AUDIT = `(() => {
  const parse = (c) => { const p = (c.match(/[\\d.]+/g) || [0,0,0]).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (f, b) => ({
    r: f.a * f.r + (1 - f.a) * b.r,
    g: f.a * f.g + (1 - f.a) * b.g,
    b: f.a * f.b + (1 - f.a) * b.b, a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  // Composite every ancestor background until an opaque one is reached: a tint
  // measured on its own reports a contrast nobody ever sees.
  const bgOf = (el) => { const stack = []; let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.a > 0) stack.push(c);
      if (c.a === 1) break;
      n = n.parentNode; }
    stack.push({ r: 231, g: 235, b: 239, a: 1 });
    return stack.reduceRight((acc, c) => over(c, acc)); };

  const failures = []; let checked = 0;
  document.querySelectorAll('body *, svg text').forEach((el) => {
    const hasText = Array.prototype.some.call(el.childNodes,
      (n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight) >= 700);
    const colour = (el.namespaceURI || '').indexOf('svg') !== -1
      ? parse(cs.fill) : parse(cs.color);
    const bg = bgOf(el);
    const r = ratio(over(colour, bg), bg);
    checked++;
    if (r < (large ? 3 : 4.5)) failures.push({
      cls: String(el.getAttribute('class') || el.tagName).slice(0, 28),
      size: Math.round(size), ratio: Number(r.toFixed(2)), need: large ? 3 : 4.5,
      text: el.textContent.trim().slice(0, 32) });
  });
  return { checked: checked, failures: failures };
})()`;

interface Result {
  checked: number;
  failures: { cls: string; size: number; ratio: number; need: number; text: string }[];
}

/*
 * Vite's own entry, run by this Node. No shell, so nothing has to be escaped,
 * and no npx, which on Windows is a .cmd that cannot be spawned directly. It
 * also pins the server to the version in node_modules rather than whatever a
 * resolver picks.
 */
const viteBin = resolve("node_modules/vite/bin/vite.js");
const server = spawn(process.execPath, [viteBin, "preview", "--port", String(PORT), "--strictPort"], {
  stdio: "ignore",
});
const stop = (): void => void server.kill();
process.on("exit", stop);

const browser = await chromium.launch();
let bad = 0;
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  // The preview server needs a moment. Retry rather than guess a sleep length.
  for (let i = 0; ; i++) {
    try {
      await page.goto(URL, { waitUntil: "networkidle", timeout: 5000 });
      break;
    } catch (err) {
      if (i >= 10) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await page.waitForSelector(".season", { timeout: 15_000 });

  // Every theme on every screen. A theme is a palette, and a palette that was
  // never measured is a guess about whether someone can read a closing date.
  for (const themeId of ["instrument", "night", "warm", "sharp", "playful"]) {
    await page.evaluate(
      `(() => { const t = ${JSON.stringify(themeId)};
        localStorage.setItem('rasid.theme.v1', JSON.stringify(t));
        if (t === 'instrument') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', t); })()`,
    );
    console.log(`\n${themeId}`);
    for (const [tab, label] of [
      ["season", "الموسم"],
      ["orgs", "الجهات"],
      ["mine", "طلباتي"],
      ["settings", "الإعدادات"],
    ] as const) {
      await page.click(`[data-tab="${tab}"]`);
      const { checked, failures } = (await page.evaluate(AUDIT)) as Result;
      bad += failures.length;
      console.log(
        `  ${label.padEnd(10)} ${String(checked).padStart(4)} runs of text · ${failures.length} below the bar`,
      );
      for (const f of failures) console.log(`      ${JSON.stringify(f)}`);
    }
  }
} finally {
  await browser.close();
  stop();
}

console.log(bad === 0 ? "\ncontrast: every run of text meets 4.5:1, or 3:1 when large" : `\ncontrast: ${bad} FAILING`);
process.exit(bad === 0 ? 0 : 1);
