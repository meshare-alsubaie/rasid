/**
 * The twenty-announcement benchmark, replayed.
 *
 * The model was asked these once, by `npm run build:benchmark`, and its answers
 * were stored. This replays them through the same pipeline that builds a real
 * record, so it runs on every push and costs nothing.
 *
 * What that does and does not prove is worth being exact about. It proves the
 * pipeline still turns a verdict into the right record — the score bands, the
 * product, and the date the calendar resolves. It does not prove the model
 * still answers the same way; that is what re-running the builder is for, and
 * the stored prompt hash makes a stale benchmark visible.
 *
 * A failure here is a defect to report, never a threshold to move.
 *
 *   npm run test:benchmark
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { SYSTEM_PROMPT_SHAPE, type Classification } from "../src/pipeline/classify";
import { fromClassification } from "../src/pipeline/opportunity";
import { CASES } from "./benchmark-cases";

const FIXTURE = "data/benchmark.json";
if (!existsSync(FIXTURE)) {
  console.log(`no benchmark fixture at ${FIXTURE}. Run "npm run build:benchmark" once to create it.`);
  process.exit(1);
}

const stored = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  promptHash: string;
  builtISO: string;
  model: string;
  answers: Record<string, Classification>;
};

let failures = 0;
const fail = (line: string): void => {
  console.log(`  FAIL  ${line}`);
  failures++;
};

const livePrompt = createHash("sha256").update(SYSTEM_PROMPT_SHAPE).digest("hex").slice(0, 16);
if (livePrompt !== stored.promptHash) {
  console.log(
    `  note  the system prompt has changed since this benchmark was built\n` +
      `        (stored ${stored.promptHash}, live ${livePrompt}) — re-run "npm run build:benchmark".\n`,
  );
}
console.log(`replaying ${CASES.length} case(s) recorded ${stored.builtISO.slice(0, 10)} with ${stored.model}\n`);

console.log("  band          id            product           score  closes       verdict");
for (const c of CASES) {
  const answer = stored.answers[c.id];
  if (!answer) {
    fail(`${c.id} has no stored answer — re-run the builder`);
    continue;
  }

  const record = fromClassification({
    orgId: "benchmark",
    sourceUrl: "https://example.gov.sa/coop",
    text: c.text,
    nowISO: "2026-08-01T00:00:00.000Z",
    prior: undefined,
    firstTime: true,
    c: answer,
  });

  const problems: string[] = [];
  const score = record.relevanceScore;

  if (answer.isTrainingAnnouncement !== c.expect.isTrainingAnnouncement) {
    problems.push(`isTrainingAnnouncement=${answer.isTrainingAnnouncement}`);
  }
  if (c.expect.product && answer.product !== c.expect.product) {
    problems.push(`product=${answer.product}, expected ${c.expect.product}`);
  }
  if (c.expect.minScore !== undefined && (score ?? -1) < c.expect.minScore) {
    problems.push(`score ${score} below ${c.expect.minScore}`);
  }
  if (c.expect.maxScore !== undefined && (score ?? 999) > c.expect.maxScore) {
    problems.push(`score ${score} above ${c.expect.maxScore}`);
  }
  if (c.expect.closesISO !== undefined && record.closesISO !== c.expect.closesISO) {
    problems.push(`closes ${record.closesISO}, expected ${c.expect.closesISO}`);
  }
  // The rule the whole product turns on: never eligible before graduating.
  if (answer.product === "graduate_dev" && !record.flags.includes("wrong_product")) {
    problems.push("graduate_dev without the wrong_product flag");
  }
  if (answer.product === "graduate_dev" && record.status !== "unknown") {
    problems.push(`graduate_dev with status ${record.status}`);
  }

  const line = `  ${c.band.padEnd(13)} ${c.id.padEnd(13)} ${String(answer.product).padEnd(17)} ${String(score).padStart(5)}  ${String(record.closesISO ?? "—").padEnd(12)}`;
  if (problems.length === 0) console.log(`${line} ok`);
  else fail(`${line} ${problems.join("; ")}`);
}

console.log(
  `\n${failures === 0 ? "all 20 cases behave as specified" : `${failures} CASE(S) FAILED — these are defects, not thresholds to adjust`}`,
);
process.exit(failures === 0 ? 0 : 1);
