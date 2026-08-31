/**
 * Build the classifier benchmark, once, by asking the real model real pages.
 *
 * The benchmark itself must run in CI on every push, and CI must not spend
 * money — so the live call happens here, by hand, and what it returns is stored
 * as a fixture. From then on `npm run test:benchmark` replays the stored
 * answers and costs nothing.
 *
 * That is a real trade and worth stating plainly: replaying fixtures tests that
 * the *pipeline* still turns a verdict into the right record, not that the
 * model still answers the same way. Model drift is caught by re-running this
 * script, not by CI. It should be re-run whenever the system prompt changes,
 * and the prompt's own hash is stored beside the answers so a stale benchmark
 * is visible rather than silently reassuring.
 *
 *   npm run build:benchmark            every case (costs money)
 *   npm run build:benchmark -- --only cyber_1
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CLASSIFIER_MODEL, classify, costOf, SYSTEM_PROMPT_SHAPE, type Usage } from "../src/pipeline/classify";
import { CASES, type BenchmarkCase } from "./benchmark-cases";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

const FIXTURE = "data/benchmark.json";

interface Stored {
  promptHash: string;
  builtISO: string;
  model: string;
  answers: Record<string, unknown>;
}

const prior: Stored | null = existsSync(FIXTURE)
  ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as Stored)
  : null;

const promptHash = createHash("sha256").update(SYSTEM_PROMPT_SHAPE).digest("hex").slice(0, 16);
const answers: Record<string, unknown> = { ...(prior?.answers ?? {}) };
const spend: Usage = { inputTokens: 0, outputTokens: 0 };

const todo = CASES.filter((c: BenchmarkCase) => (only ? c.id === only : true));
console.log(`classifying ${todo.length} case(s) with ${CLASSIFIER_MODEL}\n`);

for (const c of todo) {
  const result = await classify(c.text);
  spend.inputTokens += result.usage.inputTokens;
  spend.outputTokens += result.usage.outputTokens;

  if (!result.ok) {
    console.log(`  FAIL  ${c.id.padEnd(14)} ${result.stage}: ${result.reason}`);
    continue;
  }
  /*
   * The reasoning is dropped before anything is stored.
   *
   * `relevanceReason` is the model explaining why a score fits *this* student,
   * so it quotes his profile back — his project, his certifications, his
   * specialism. That profile is deliberately kept out of the repository and in
   * a secret, and storing the model's paraphrase of it in a committed fixture
   * put it straight back in, on a public repository. The privacy gate caught
   * it, which is the gate working; the fix is that the benchmark never had any
   * use for the prose. It checks scores, products and dates.
   */
  const { relevanceReason: _dropped, ...withoutReasoning } = result.value;
  answers[c.id] = { ...withoutReasoning, relevanceReason: "" };
  console.log(
    `  ok    ${c.id.padEnd(14)} product=${result.value.product.padEnd(16)} score=${String(result.value.relevanceScore).padStart(3)}  closesRaw=${JSON.stringify(result.value.closesRaw)}`,
  );
}

/*
 * A rebuild that answered nothing must not claim to be fresh.
 *
 * This wrote the new prompt hash unconditionally, so when the API refused every
 * call — the account had run out of credit — the fixture kept the *old* answers
 * under the *new* hash, and the drift warning went quiet. The benchmark would
 * then have gone on passing in CI while testing a prompt that no longer exists.
 * A tool that reports on staleness must not be able to lie about its own.
 */
const answered = todo.filter((c) => answers[c.id] !== undefined).length;
const wholeSetRebuilt = only === undefined && answered === todo.length;

if (answered === 0) {
  console.log("\nnothing was classified, so the fixture is left exactly as it was.");
} else {
  writeFileSync(
    FIXTURE,
    JSON.stringify(
      {
        // Only a complete, successful rebuild may claim to match this prompt.
        promptHash: wholeSetRebuilt ? promptHash : (prior?.promptHash ?? promptHash),
        builtISO: wholeSetRebuilt ? new Date().toISOString() : (prior?.builtISO ?? new Date().toISOString()),
        model: CLASSIFIER_MODEL,
        answers,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

console.log(
  `\nstored ${Object.keys(answers).length} answer(s) in ${FIXTURE}` +
    `\nspend: ${spend.inputTokens} in / ${spend.outputTokens} out = $${costOf(spend).toFixed(4)}` +
    `\nprompt hash ${promptHash} — the benchmark warns if this drifts from the live prompt.`,
);
