import type { Stage } from "../engine/route.ts";
import type { Verdict } from "../engine/verdict.ts";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** A JSON Schema for the structured Verdict a Run returns (`claude --json-schema`). */
export interface VerdictSchema {
  type: "object";
  properties: { verdict: { type: "string"; enum: Verdict[] } };
  required: ["verdict"];
  additionalProperties: false;
}

export interface RunSpec {
  task: string;
  stage: Stage;
  /** The Agent doing this Run: one of the Stage's Agents. */
  agent: string;
  workdir: string;
  /** Where the Agent must leave its report for this Stage. */
  reportPath: string;
  /** The Agent's role prompt and Skills, with the Output contract and the Precedents pointer. */
  systemPrompt: string;
  /** The Task, its earlier reports and the findings to fix. */
  userPrompt: string;
  /** Allows exactly the Verdicts the Agent's Output contract lists. */
  verdictSchema: VerdictSchema;
  /** Every Skill folder to copy into the container's `.claude/skills/`, preloaded or available. */
  skills: { name: string; dir: string }[];
  /** What the Agent sets in its AGENT.md. Absent: the Runner's default. */
  model?: string;
  effort?: string;
  image?: string;
  tools?: string[];
  /** Wall-clock limit for the Run, in milliseconds. */
  timeoutMs?: number;
  maxTokens?: number;
}

export interface RunResult {
  verdict: Verdict;
  reportPath: string;
  usage: Usage;
}

export interface Runner {
  run(spec: RunSpec): Promise<RunResult>;
}
