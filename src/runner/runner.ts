import type { Stage, Verdict } from "../engine/route.ts";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface RunSpec {
  task: string;
  stage: Stage;
  workdir: string;
  /** Where the Agent must leave its report for this Stage. */
  reportPath: string;
}

export interface RunResult {
  verdict: Verdict;
  reportPath: string;
  usage: Usage;
}

export interface Runner {
  run(spec: RunSpec): Promise<RunResult>;
}
