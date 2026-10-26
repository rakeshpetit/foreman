import type { Stage, Verdict } from "../engine/route.ts";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** A JSON Schema for the structured Verdict a Run returns (`claude --json-schema`). */
export interface VerdictSchema {
  type: "object";
  properties: { verdict: { type: "string"; enum: string[] } };
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
  /**
   * What an AGENT.md adds, filled in by `assembleRunSpec`. Optional until the engine builds specs
   * from AGENT.md files (M2-T07); the FakeRunner ignores all of it.
   */
  systemPrompt?: string;
  userPrompt?: string;
  verdictSchema?: VerdictSchema;
  model?: string;
  effort?: string;
  image?: string;
  tools?: string[];
  /** Wall-clock limit for the Run, in milliseconds. */
  timeoutMs?: number;
  maxTokens?: number;
  /** Every Skill folder to copy into the container's `.claude/skills/`, preloaded or available. */
  skills?: { name: string; dir: string }[];
}

export interface RunResult {
  verdict: Verdict;
  reportPath: string;
  usage: Usage;
}

export interface Runner {
  run(spec: RunSpec): Promise<RunResult>;
}
