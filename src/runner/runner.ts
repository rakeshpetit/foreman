import type { Stage, Verdict } from "../engine/route.ts";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface RunSpec {
  task: string;
  stage: Stage;
  /** The Agent doing this Run: one of the Stage's Agents. */
  agent: string;
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
