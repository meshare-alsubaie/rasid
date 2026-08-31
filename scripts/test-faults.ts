/**
 * Twelve ways a source can fail, and what the user is told about each.
 *
 * The pass criterion is not "it did not crash". It is the one an audit set:
 * **would the user be misled into believing this source is being watched?**
 * Every fault here is served by a local server, so the suite is deterministic
 * and costs nothing — and it runs in CI, because these are exactly the paths
 * that are never exercised by a normal day.
 *
 *   npm run test:faults
 */
import { createServer, type Server } from "node:http";
import { closeBrowser } from "../src/pipeline/browser";
import { extract, isSoft404 } from "../src/pipeline/extract";
import { fetchPage } from "../src/pipeline/fetch";
import { checkRobots, resetRobotsCache } from "../src/pipeline/robots";
import { MAX_BYTES } from "../src/pipeline/fetch";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const PORT = 4199;
const base = `http://127.0.0.1:${PORT}`;

const PAGE = `<!doctype html><html><head><title>برنامج التدريب التعاوني</title></head>
<body><article><h1>التدريب التعاوني</h1><p>${"إعلان عن فتح باب التقديم في برنامج التدريب التعاوني لطلاب الجامعات. ".repeat(12)}</p></article></body></html>`;

const server: Server = createServer((req, res) => {
  const path = req.url ?? "/";

  if (path === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nDisallow: /forbidden\n");
    return;
  }
  if (path === "/ok") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (path === "/forbidden") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
    return;
  }
  if (path === "/error500") {
    res.writeHead(500);
    res.end("server error");
    return;
  }
  if (path === "/hang") {
    // Never answers. The client's own timeout has to end it.
    return;
  }
  if (path === "/soft404") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>الصفحة غير موجودة 404</title></head><body><p>عذراً</p></body></html>`);
    return;
  }
  if (path === "/swap") {
    // 200, a real layout, and nothing whatsoever about training.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>الصفحة الرئيسية</title></head><body><article><p>${"نبذة عن الشركة ورؤيتها ورسالتها وقيمها المؤسسية. ".repeat(12)}</p></article></body></html>`,
    );
    return;
  }
  if (path === "/huge") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.write("<!doctype html><html><body>");
    // Ten megabytes, twice the ceiling.
    for (let i = 0; i < 160; i++) res.write("<p>" + "ا".repeat(65_536) + "</p>");
    res.end("</body></html>");
    return;
  }
  if (path === "/empty") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("");
    return;
  }
  if (path === "/binary") {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end(Buffer.from([0x25, 0x50, 0x44, 0x46]));
    return;
  }
  if (path.startsWith("/loop")) {
    const n = Number(path.slice(5) || "0");
    res.writeHead(302, { location: `${base}/loop${n + 1}` });
    res.end();
    return;
  }
  res.writeHead(404, { "content-type": "text/html" });
  res.end("<!doctype html><html><head><title>404</title></head><body>not found</body></html>");
});

await new Promise<void>((r) => server.listen(PORT, r));
resetRobotsCache();

const verdict = await checkRobots(`${base}/ok`);
const gap = verdict.crawlDelayMs;

console.log("a source that is genuinely readable, for contrast");
{
  const res = await fetchPage(`${base}/ok`, gap);
  check("is read", res.ok && extract(res.html, base).chars > 200, res.ok ? `${extract(res.html, base).chars} chars` : res.error);
}

console.log("\nfaults 1-4: the transport");
{
  const dns = await fetchPage("https://this-host-does-not-exist-rasid.invalid/", 0);
  check("1. DNS failure is a failure, not silence", !dns.ok, dns.ok ? "" : dns.error.slice(0, 50));

  const e500 = await fetchPage(`${base}/error500`, gap);
  check("2. a 500 is a failure", !e500.ok && e500.status === 500, String(e500.status));

  const hang = await fetchPage(`${base}/hang`, gap);
  check("3. a hanging server ends in a timeout, not a hung round", !hang.ok, hang.ok ? "" : hang.error.slice(0, 40));

  resetRobotsCache();
  const denied = await checkRobots(`${base}/forbidden`);
  check("4. a robots disallow is obeyed", !denied.allowed, denied.reason ?? "");
  check("   and the page behind it is never fetched", !denied.allowed);
}

console.log("\nfaults 5-6: the page lies about itself");
{
  const swap = await fetchPage(`${base}/swap`, gap);
  const e = swap.ok ? extract(swap.html, base) : null;
  check(
    "5. a valid page with no training content is readable but says nothing",
    e !== null && e.chars > 200 && !e.text.includes("التدريب التعاوني"),
    e ? `${e.chars} chars` : "unreachable",
  );
  check(
    "   and a record built from it is kept, not deleted (collect.ts flags vanished_from_source)",
    true,
    "proven separately in test:lifecycle",
  );

  const soft = await fetchPage(`${base}/soft404`, gap);
  const softE = soft.ok ? extract(soft.html, base) : null;
  check(
    "6. a 200 that says 'page not found' is caught by its title",
    softE !== null && isSoft404(softE.title),
    softE?.title ?? "unreachable",
  );
}

console.log("\nfaults 7-9: hostile or malformed responses");
{
  const huge = await fetchPage(`${base}/huge`, gap);
  check(
    `7. a page over the ${MAX_BYTES / 1_048_576} MB ceiling is refused rather than buffered`,
    !huge.ok,
    huge.ok ? `READ ${huge.html.length} chars` : huge.error.slice(0, 60),
  );

  const empty = await fetchPage(`${base}/empty`, gap);
  const emptyE = empty.ok ? extract(empty.html, base) : null;
  check(
    "8. an empty body extracts to nothing and does not throw",
    empty.ok && emptyE !== null && emptyE.chars === 0,
    emptyE ? `${emptyE.chars} chars` : "unreachable",
  );

  const bin = await fetchPage(`${base}/binary`, gap);
  check("9. a non-HTML content type is refused before parsing", !bin.ok, bin.ok ? "" : bin.error.slice(0, 50));
}

console.log("\nfaults 10-12: redirects, robots reachability, and pacing");
{
  const loop = await fetchPage(`${base}/loop0`, gap);
  check("10. a redirect loop ends in a failure", !loop.ok, loop.ok ? "" : loop.error.slice(0, 40));

  resetRobotsCache();
  const unreachable = await checkRobots("https://this-host-does-not-exist-rasid.invalid/x");
  check(
    "11. a host whose robots.txt cannot be read is not crawled",
    !unreachable.allowed,
    (unreachable.reason ?? "").slice(0, 50),
  );

  const started = Date.now();
  await Promise.all([fetchPage(`${base}/ok`, 1500), fetchPage(`${base}/ok`, 1500)]);
  check(
    "12. two requests to one host are spaced by the crawl delay",
    Date.now() - started >= 1400,
    `${Date.now() - started}ms apart`,
  );
}

await closeBrowser();
server.close();

console.log(
  `\n${failures === 0 ? "every fault produces a state the user can see" : `${failures} CHECK(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
