import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unknownName } from "../config/issues.ts";
import { VERDICTS, type Verdict } from "../engine/verdict.ts";
import type { Runner, RunResult, RunSpec, Usage } from "./runner.ts";

export interface FakeStep {
  verdict: Verdict;
  /** Files to write, keyed by path relative to the workdir. */
  files?: Record<string, string>;
  usage?: Partial<Usage>;
}

/**
 * Per Agent name or Stage name, the steps to play in order; once exhausted (or unscripted) a Run
 * passes. A Run uses its Agent's steps if the script has any for that name, else its Stage's.
 */
export type FakeScript = Record<string, FakeStep[]>;

const NO_USAGE: Usage = {
  tokens_in: 0,
  tokens_out: 0,
  cache_read: 0,
  cache_write: 0,
  context_peak: null,
  cost_usd: 0,
};

/**
 * Checks a script read from JSON: only `known` Stage and Agent names (any, when `known` is absent),
 * and every step has a Verdict foreman knows.
 */
export function parseFakeScript(json: unknown, known?: ReadonlySet<string>): FakeScript {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("a script is an object of Stage or Agent → steps");
  }
  const script: FakeScript = {};
  for (const [stage, steps] of Object.entries(json)) {
    if (known && !known.has(stage)) {
      throw new Error(unknownName("stage or agent", stage, known));
    }
    if (!Array.isArray(steps)) throw new Error(`${stage}: steps must be an array`);
    script[stage] = steps.map((step) => {
      const verdict = VERDICTS.find((v) => v === step?.verdict);
      if (!verdict) throw new Error(`${stage}: verdict must be one of ${VERDICTS.join(", ")}`);
      return { ...step, verdict };
    });
  }
  return script;
}

export class FakeRunner implements Runner {
  readonly calls: RunSpec[] = [];
  readonly #script: Record<string, FakeStep[]>;

  constructor(script: FakeScript = {}) {
    this.#script = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  }

  async run(spec: RunSpec): Promise<RunResult> {
    this.calls.push(spec);
    const steps = this.#script[spec.agent]?.length
      ? this.#script[spec.agent]
      : this.#script[spec.stage];
    const step = steps?.shift() ?? { verdict: "PASS" };
    for (const [path, content] of Object.entries(step.files ?? {})) {
      const file = join(spec.workdir, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await mkdir(dirname(spec.reportPath), { recursive: true });
    await writeFile(spec.reportPath, `# ${spec.stage} report\n\nverdict: ${step.verdict}\n`);
    const usage = { ...NO_USAGE, ...step.usage };
    return {
      verdict: step.verdict,
      reportPath: spec.reportPath,
      usage,
      stdout: JSON.stringify({ verdict: step.verdict, usage }),
    };
  }
}
