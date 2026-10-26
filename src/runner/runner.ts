import type { Stage } from "../engine/route.ts";
import type { Verdict } from "../engine/verdict.ts";

/** What a Run used. Token counts are named as Claude names them. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /**
   * The fullest context of the model calls the result lists, in tokens. Claude's result lists only
   * the last call, so this is that call's context: an approximation of the peak. Null when absent.
   */
  context_peak: number | null;
  /** At list price. */
  cost_usd: number;
}

/** A JSON Schema for the structured Verdict a Run returns (`claude --json-schema`). */
export interface VerdictSchema {
  type: "object";
  properties: { verdict: { type: "string"; enum: Verdict[] } };
  required: ["verdict"];
  additionalProperties: false;
}

export interface RunSpec {
  /** The `runs` row this Run fills in. */
  runId: number;
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
  /** The model that did the work, as Claude names it. Absent: the Runner could not tell. */
  model?: string;
  /** What the Run printed, for the caller to keep. */
  raw: string;
}

export interface Runner {
  run(spec: RunSpec): Promise<RunResult>;
}

/** Why a Run produced no usable result. */
export type RunFailureKind =
  /** It ran past its wall-clock limit and was killed. */
  | "timeout"
  /** The container exited non-zero, or Claude reported an error. */
  | "failed"
  /** Claude could not log in: a bad or expired token, which a retry cannot fix. */
  | "auth"
  /** The subscription's usage limit is reached: nothing can run until it resets, so a retry cannot help. */
  | "usage-limit"
  /** It exited cleanly but left no valid Verdict: unparseable output, a missing or disallowed Verdict. */
  | "invalid-result"
  /** It left a Verdict but not the report its Output contract asks for. */
  | "missing-report";

export class RunFailure extends Error {
  readonly kind: RunFailureKind;
  /** Everything the container printed, for the caller to keep. */
  readonly stdout: string;
  /** What the Run spent before it failed, when its output says. */
  readonly usage?: Usage;
  /** For `usage-limit`: when the limit resets, if the output says. */
  readonly resetsAt?: Date;

  constructor(kind: RunFailureKind, message: string, stdout = "", usage?: Usage, resetsAt?: Date) {
    super(message);
    this.kind = kind;
    this.stdout = stdout;
    this.usage = usage;
    this.resetsAt = resetsAt;
  }
}
