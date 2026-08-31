/**
 * The PowerShell entry points parse, and stay parseable.
 *
 * `scheduled-run.ps1` is how collection actually happens — the machine in
 * Riyadh is the only one that can reach most of these sites — and nothing in
 * the test suite ever looked at it. Two typographic dashes in a comment were
 * enough to stop it parsing, and the failure had the worst possible shape: the
 * task exited 1, nothing reached the log because the log is written from inside
 * the script, and the app went on showing a calm "checked N hours ago" while no
 * collection had run at all.
 *
 * Windows PowerShell 5.1 reads a `.ps1` with no byte-order mark in the system
 * codepage, so any character outside ASCII is a hazard rather than a style
 * choice. Both things are checked here: that the file parses, and that it
 * cannot acquire the characters that stop it parsing.
 *
 *   npm run test:scripts
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const dir = "scripts";
const shell = readdirSync(dir).filter((f) => f.endsWith(".ps1"));

console.log(`${shell.length} PowerShell script(s)\n`);

console.log("plain ASCII, because the parser depends on it");
for (const file of shell) {
  const text = readFileSync(join(dir, file), "utf8");
  const offenders = new Map<string, number>();
  for (const ch of text) {
    if (ch.codePointAt(0)! > 127) {
      offenders.set(ch, (offenders.get(ch) ?? 0) + 1);
    }
  }
  const shown = [...offenders]
    .map(([ch, n]) => `${JSON.stringify(ch)} U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} x${n}`)
    .join(", ");
  check(file, offenders.size === 0, shown);
}

/*
 * Parsed by PowerShell itself rather than by anything approximating it. The
 * abstract syntax tree is thrown away; only the error list matters.
 */
console.log("\nparses");
const isWindows = process.platform === "win32";
if (!isWindows) {
  console.log("  skipped: not running on Windows, and PowerShell 5.1 is the parser that matters");
} else {
  for (const file of shell) {
    const full = join(process.cwd(), dir, file).replace(/'/g, "''");
    const probe = `
      $errors = $null
      $null = [System.Management.Automation.Language.Parser]::ParseFile('${full}', [ref]$null, [ref]$errors)
      if ($errors) { $errors | ForEach-Object { "line " + $_.Extent.StartLineNumber + ": " + $_.Message } } else { "OK" }`;
    let out: string;
    try {
      out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", probe],
        { encoding: "utf8", timeout: 60_000 },
      ).trim();
    } catch (err) {
      out = `could not run the parser: ${(err as Error).message}`;
    }
    check(file, out === "OK", out === "OK" ? "" : out.split("\n")[0]);
  }
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
