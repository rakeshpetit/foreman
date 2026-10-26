import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Stage } from "../engine/route.ts";
import type { Runner, RunResult, RunSpec, Usage } from "./runner.ts";

export interface FakeStep {
  verdict: "pass" | "fail";
  /** Files to write, keyed by path relative to the workdir. */
  files?: Record<string, string>;
  usage?: Usage;
}

/** Per Stage, the steps to play in order; once exhausted (or unscripted) a Stage passes. */
export type FakeScript = Partial<Record<Stage, FakeStep[]>>;

const NO_USAGE: Usage = { input_tokens: 0, output_tokens: 0 };

export class FakeRunner implements Runner {
  readonly calls: RunSpec[] = [];
  readonly #script: Record<string, FakeStep[]>;

  constructor(script: FakeScript = {}) {
    this.#script = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  }

  async run(spec: RunSpec): Promise<RunResult> {
    this.calls.push(spec);
    const step = this.#script[spec.stage]?.shift() ?? { verdict: "pass" };
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
