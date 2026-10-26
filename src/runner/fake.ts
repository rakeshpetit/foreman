import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PIPELINE, type Stage, VERDICTS, type Verdict } from "../engine/route.ts";
import type { Runner, RunResult, RunSpec, Usage } from "./runner.ts";

export interface FakeStep {
  verdict: Verdict;
  /** Files to write, keyed by path relative to the workdir. */
  files?: Record<string, string>;
  usage?: Usage;
}

/** Per Stage, the steps to play in order; once exhausted (or unscripted) a Stage passes. */
export type FakeScript = Partial<Record<Stage, FakeStep[]>>;

const NO_USAGE: Usage = { input_tokens: 0, output_tokens: 0 };

/** Checks a script read from JSON: known Stages only, and every step has a Verdict foreman knows. */
export function parseFakeScript(json: unknown): FakeScript {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("a script is an object of Stage → steps");
  }
  for (const [stage, steps] of Object.entries(json)) {
    if (!(PIPELINE as readonly string[]).includes(stage)) {
      throw new Error(`unknown stage ${JSON.stringify(stage)}`);
    }
    if (!Array.isArray(steps)) throw new Error(`${stage}: steps must be an array`);
    for (const step of steps) {
      if (!(VERDICTS as readonly unknown[]).includes(step?.verdict)) {
        throw new Error(`${stage}: verdict must be one of ${VERDICTS.join(", ")}`);
      }
    }
  }
  return json as FakeScript;
}

export class FakeRunner implements Runner {
  readonly calls: RunSpec[] = [];
  readonly #script: Record<string, FakeStep[]>;

  constructor(script: FakeScript = {}) {
    this.#script = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  }

  async run(spec: RunSpec): Promise<RunResult> {
    this.calls.push(spec);
    const step = this.#script[spec.stage]?.shift() ?? { verdict: "PASS" };
    for (const [path, content] of Object.entries(step.files ?? {})) {
      const file = join(spec.workdir, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await mkdir(dirname(spec.reportPath), { recursive: true });
    await writeFile(spec.reportPath, `# ${spec.stage} report\n\nverdict: ${step.verdict}\n`);
    return { verdict: step.verdict, reportPath: spec.reportPath, usage: step.usage ?? NO_USAGE };
  }
}
