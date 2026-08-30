/**
 * Spec acceptance criterion 8.7, measured rather than asserted.
 *
 * "Lighthouse: Performance >= 90, Accessibility >= 95." That line sat in the
 * specification unmeasured for the whole build, which is the same failure the
 * rest of this project is built to avoid: a claim with nothing behind it. So it
 * is a script, it runs against the real build, and it exits non-zero when the
 * numbers are not there.
 *
 * Mobile emulation is the default, deliberately. The person this is for reads
 * it on a phone, and a desktop score would be the flattering measurement rather
 * than the true one.
 *
 *   npm run audit:lighthouse
 *   npm run audit:lighthouse -- --desktop
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import lighthouse from "lighthouse";
import { chromium } from "playwright";

const DESKTOP = process.argv.includes("--desktop");
const DIST = "dist";
const PORT = 4173;
const DEBUG_PORT = 9222;

const BARS = { performance: 90, accessibility: 95 } as const;

if (!existsSync(DIST)) {
  console.error(`no ${DIST}/ — run "npm run build" first`);
  process.exit(1);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

/*
 * The site is served from a sub-path on Pages, and the build is written for
 * that. Serving it at the root would 404 every asset and score a zero that
 * says nothing about the app.
 */
const BASE = "/rasid/";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = decodeURIComponent(url.pathname);
  if (path.startsWith(BASE)) path = path.slice(BASE.length - 1);

  let file = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");

  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

await new Promise<void>((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch({
  headless: true,
  args: [`--remote-debugging-port=${DEBUG_PORT}`, "--disable-dev-shm-usage"],
});

try {
  const result = await lighthouse(
    `http://localhost:${PORT}${BASE}`,
    { port: DEBUG_PORT, output: "json", logLevel: "error" },
    DESKTOP ? { extends: "lighthouse:default", settings: { formFactor: "desktop", screenEmulation: { disabled: true } } } : undefined,
  );

  if (!result) throw new Error("lighthouse returned nothing");

  const scores = Object.fromEntries(
    Object.entries(result.lhr.categories).map(([id, c]) => [id, Math.round((c.score ?? 0) * 100)]),
  ) as Record<string, number>;

  console.log(`\nlighthouse (${DESKTOP ? "desktop" : "mobile"})\n`);
  let failed = 0;
  for (const [id, score] of Object.entries(scores)) {
    const bar = BARS[id as keyof typeof BARS];
    const verdict = bar === undefined ? "" : score >= bar ? `  (bar ${bar})` : `  BELOW THE BAR OF ${bar}`;
    if (bar !== undefined && score < bar) failed++;
    console.log(`  ${String(score).padStart(3)}  ${id}${verdict}`);
  }

  /*
   * The failing audits are printed, not just the number. A score is a summary;
   * what has to be fixed is the list underneath it.
   */
  if (failed > 0) {
    console.log("\nwhat is costing the score:");
    for (const audit of Object.values(result.lhr.audits)) {
      if (audit.score !== null && audit.score < 0.9 && audit.scoreDisplayMode !== "notApplicable") {
        console.log(`  ${audit.id}: ${audit.title}`);
      }
    }
  }

  console.log(
    failed === 0
      ? "\nlighthouse: acceptance criterion 8.7 met"
      : `\nlighthouse: ${failed} categor${failed === 1 ? "y is" : "ies are"} below the bar`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
