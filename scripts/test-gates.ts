/**
 * The checkers are themselves checked.
 *
 * Twice now a gate has passed while checking nothing. `tsconfig.app.json`
 * inherited an `exclude` that cancelled its own `include`, so the entire
 * browser half of the application went unchecked for the whole build and a
 * syntax error reached a pushed commit. And the privacy scanner read only
 * tracked files, so a generated fixture carrying the owner's project name was
 * committed before anything looked at it.
 *
 * Both failures had the same shape: a green tick from a tool that was not
 * looking. The only defence is to make the tool fail on demand — plant a fault
 * it must catch, and assert that it does.
 *
 *   npm run test:gates
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Runs an npm script and reports whether it failed, never throwing.
 *
 * Everything goes through npm rather than through the tools directly. The first
 * version of this ran `npx tsc`, which does not launch on Windows the way it
 * does elsewhere — so every command "failed", and a test asserting that a
 * planted fault is caught passed for the wrong reason. A harness that cannot
 * tell a caught fault from a failed launch is the same bug it was written to
 * prevent, which is why each case below also asserts the clean state passes.
 */
function run(script: string): { code: number; out: string } {
  try {
    const out = execFileSync(npm, ["run", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Node refuses to execute a .cmd shim without a shell, and every npm on
      // Windows is one. Without this every command "fails" and a test that
      // asserts a fault is caught passes for the wrong reason.
      shell: process.platform === "win32",
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

console.log("the type checker actually reaches the browser code");
{
  const probe = "src/app/gate-probe.ts";
  writeFileSync(probe, 'export const wrong: number = "a string, deliberately";\n', "utf8");
  const before = run("typecheck");
  rmSync(probe);
  const after = run("typecheck");

  check(
    "a planted type error in src/app fails the check",
    before.code !== 0,
    before.code === 0 ? "IT PASSED — src/app is not being checked" : "",
  );
  check(
    "and the error names the file",
    /gate-probe/.test(before.out),
    before.out.split("\n").find((l) => l.includes("error")) ?? "no error text",
  );
  check("removing it makes the check pass again", after.code === 0);
}

console.log("\nthe privacy scanner reaches a file that is not committed yet");
{
  /*
   * The exact hole that let a leak through: `git ls-files` lists tracked files
   * only, so anything newly generated was invisible until after it had been
   * committed — which is the one moment when catching it still costs nothing.
   */
  if (!existsSync("data")) mkdirSync("data");
  const probe = "data/gate-probe.json";
  writeFileSync(probe, JSON.stringify({ note: "First Class Honours" }) + "\n", "utf8");
  const untracked = run("audit:privacy");
  rmSync(probe);
  const clean = run("audit:privacy");

  check(
    "an untracked file carrying a personal detail is caught",
    untracked.code !== 0,
    untracked.code === 0 ? "IT PASSED — only tracked files are scanned" : "",
  );
  check("and the report names it", /gate-probe/.test(untracked.out));
  check("removing it makes the scan clean again", clean.code === 0);
}

console.log("\nthe validator refuses a dataset that breaks an honesty rule");
{
  const path = "data/opportunities.json";
  // Read from disk, not from git: the working tree is what the validator is
  // about to judge, and restoring an older revision over it would leave the
  // dataset inconsistent with the health and snapshot files beside it.
  const original = readFileSync(path, "utf8");
  const records = JSON.parse(original) as Record<string, unknown>[];
  // "Open now" with no date behind it: the worst false state the app can hold.
  records.push({
    ...(records[0] ?? {}),
    id: "gateprobe0000000",
    status: "open",
    opensISO: null,
    closesISO: null,
    flags: [],
  });
  writeFileSync(path, JSON.stringify(records, null, 2) + "\n", "utf8");
  const broken = run("validate");
  writeFileSync(path, original, "utf8");
  const restored = run("validate");

  check(
    "a window open with no published date is rejected",
    broken.code !== 0,
    broken.code === 0 ? "IT PASSED — the rule is not enforced" : "",
  );
  check("and it is named as such", /open_without_dates/.test(broken.out));
  check("restoring the file makes it pass again", restored.code === 0);
}

console.log(`\n${failures === 0 ? "every gate fails when it should" : `${failures} GATE(S) DO NOT CATCH WHAT THEY CLAIM TO`}`);
process.exit(failures === 0 ? 0 : 1);
