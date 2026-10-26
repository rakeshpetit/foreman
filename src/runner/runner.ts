import type { Stage } from "../engine/route.ts";
import type { Verdict } from "../engine/verdict.ts";

/** What a Run used, named for the `runs` columns it fills. */
export interface Usage {
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  /**
   * The fullest context of any call to the model in the Run, in tokens: the largest of input plus
   * both caches over Claude's `assistant` messages. Null when the Run made no call.
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
}

export interface RunResult {
  verdict: Verdict;
  reportPath: string;
  usage: Usage;
  /** The model that did the work, as Claude names it. Absent: the Runner could not tell. */
  model?: string;
  /** What the Run printed, for the caller to keep. */
  stdout: string;
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

/** What a failed Run knows beyond its kind and message. Every field is optional. */
export interface RunFailureDetails {
  /** Everything the container printed, for the caller to keep. */
  stdout?: string;
  /** What the Run spent before it failed, when its output says. */
  usage?: Usage;
  /** `docker run`'s exit code, when the container got far enough to have one. */
  exitCode?: number;
  /** For `usage-limit`: when the limit resets, if the output says. */
  resetsAt?: Date;
}

export class RunFailure extends Error {
  readonly kind: RunFailureKind;
  readonly stdout: string;
  readonly usage?: Usage;
  readonly exitCode?: number;
  readonly resetsAt?: Date;

  constructor(kind: RunFailureKind, message: string, details: RunFailureDetails = {}) {
    super(message);
    this.kind = kind;
    this.stdout = details.stdout ?? "";
    this.usage = details.usage;
    this.exitCode = details.exitCode;
    this.resetsAt = details.resetsAt;
  }
}
