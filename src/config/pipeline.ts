import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { LANES, type Lane } from "../store/lane.ts";
import { agentNames } from "./agent.ts";
import { ConfigFileError, formatPath, unknownName } from "./issues.ts";
import { FOREMAN_DIR } from "./skill.ts";

/** The end of the Pipeline: where `on_pass` leads from the last Stage. Not a Stage name. */
export const DONE = "done";

/** The Kind that names the Agents of every agent Stage, for a Task whose own Kind leaves one out (ADR 0011). */
export const DEFAULT_KIND = "default";

export const DEFAULT_PIPELINE_PATH = join(import.meta.dirname, "../../defaults/pipeline.toml");

const STAGE_TYPES = ["agent", "gate", "owner"] as const;
const NOTIFY_EVENTS = ["task_done", "request_done", "engine_error"] as const;

const names = z.array(z.string().min(1)).min(1);

const stageSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/, "use lowercase letters, digits, - and _"),
    type: z.enum(STAGE_TYPES),
    // Agents live under `kinds`, never on a Stage (ADR 0011). Named so the message says where to go.
    agents: z
      .never({
        error:
          'a stage has no agents of its own; list them under [kinds.default], e.g. name = ["agent"]',
      })
      .optional(),
    require: z.enum(["all", "any"]).optional(),
    gates: names.optional(),
    on_pass: z.string().optional(),
    on_fail: z.string().optional(),
    max_rounds: z.int().positive().optional(),
    lanes: z.array(z.enum(LANES)).min(1).optional(),
  })
  // Named here, not by path, so the message says which Stage; this also types `on_fail` as present.
  .transform(({ on_fail, ...s }, ctx) => {
    if (on_fail === undefined) {
      ctx.issues.push({
        code: "custom",
        input: s,
        message: `on_fail is required for stage "${s.name}", to say where a failed ${s.name} sends the Task (e.g. on_fail = "implement")`,
      });
      return z.NEVER;
    }
    return { ...s, on_fail };
  });

const pipelineSchema = z.strictObject({
  stages: z.array(stageSchema).min(1),
  kinds: z.record(z.string(), z.record(z.string(), names)).default({}),
  breaker: z
    .strictObject({
      per_stage: z.int().positive().default(3),
      per_task: z.int().positive().default(6),
    })
    .prefault({}),
  notify: z
    .strictObject({
      usage: z.enum(["task", "off"]).default("task"),
      events: z.array(z.enum(NOTIFY_EVENTS)).default([...NOTIFY_EVENTS]),
    })
    .prefault({}),
  lanes: z
    .partialRecord(z.enum(LANES), z.strictObject({ under_lines: z.int().positive().optional() }))
    .default({ normal: {} }),
});

type Parsed = z.output<typeof pipelineSchema>;
type Checked = Omit<Parsed, "stages"> & {
  stages: (Parsed["stages"][number] & { on_pass: string })[];
};
type CheckedStage = Checked["stages"][number];

/** One Stage of the Pipeline, as configured. */
export interface StageConfig {
  name: string;
  type: (typeof STAGE_TYPES)[number];
  /** Agent stages: how the Agents' Verdicts combine. */
  require: "all" | "any";
  /** Gate stages only: the Gates to run, in turn. */
  gates?: string[];
  /** The Stage after a pass, or `done`. Defaults to the next Stage in order. */
  on_pass: string;
  /** Where a failed Stage sends the Task. A Stage name, never `done`. */
  on_fail: string;
  /** Overrides `breaker.per_stage` for this Stage. */
  max_rounds?: number;
  /** The lanes this Stage runs in. Absent means every lane. */
  lanes?: Lane[];
}

export interface Pipeline {
  stages: StageConfig[];
  /**
   * Kind → Stage → Agents, the Agents that run in turn. The `default` Kind names every agent Stage,
   * and is what a Task gets for a Stage its own Kind leaves out (ADR 0011).
   */
  kinds: Record<string, Record<string, string[]>>;
  breaker: { per_stage: number; per_task: number };
  notify: { usage: "task" | "off"; events: (typeof NOTIFY_EVENTS)[number][] };
  lanes: Parsed["lanes"];
}

export interface PipelineOptions {
  /** Every Agent name that exists, to catch a typo in `kinds`. Unchecked when absent; `loadPipeline` fills it in. */
  agents?: ReadonlySet<string>;
  /** Every Gate name that exists, to catch a typo in `gates`. Unchecked when absent. */
  gates?: ReadonlySet<string>;
  /** Named in error messages. Defaults to `pipeline.toml`. */
  source?: string;
}

/** Every problem with a `pipeline.toml`, one readable line each (`issues`), prefixed by its source. */
export class PipelineError extends ConfigFileError {}

/** Loads a Pipeline file, checking its Agents against foreman's own `agents/` unless `agents` says otherwise. */
export function loadPipeline(path: string, opts: Omit<PipelineOptions, "source"> = {}): Pipeline {
  const agents = opts.agents ?? agentNames(join(FOREMAN_DIR, "agents"));
  return parsePipeline(readFileSync(path, "utf8"), { ...opts, agents, source: path });
}

/** Parses and validates a `pipeline.toml`, filling in defaults. Throws a `PipelineError` listing every problem. */
export function parsePipeline(text: string, opts: PipelineOptions = {}): Pipeline {
  const source = opts.source ?? "pipeline.toml";
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new PipelineError(
      [`not valid TOML: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`],
      source,
    );
  }
  return validatePipeline(raw, { ...opts, source });
}

/** Validates an already-parsed `pipeline.toml` table, e.g. one merged from several config layers. */
export function validatePipeline(raw: unknown, opts: PipelineOptions = {}): Pipeline {
  const source = opts.source ?? "pipeline.toml";
  const shape = pipelineSchema.safeParse(raw);
  if (!shape.success) {
    throw new PipelineError(
      shape.error.issues.map((i) => `${formatPath(i.path, "pipeline")}: ${i.message}`),
      source,
    );
  }
  const parsed = withDefaultOnPass(shape.data);
  const issues = checkMeaning(parsed, opts);
  if (issues.length > 0) throw new PipelineError(issues, source);
  return resolve(parsed);
}

/** The names a `--fake` script may key its steps by: every Stage and every Agent in the Pipelines. */
export function scriptNames(pipelines: Pipeline[]): Set<string> {
  const names = new Set<string>();
  for (const pipeline of pipelines) {
    for (const s of pipeline.stages) {
      names.add(s.name);
    }
    for (const byStage of Object.values(pipeline.kinds)) {
      for (const agents of Object.values(byStage)) for (const a of agents) names.add(a);
    }
  }
  return names;
}

/** `on_pass` defaults to the next Stage in order, or `done` after the last. */
function withDefaultOnPass(p: Parsed): Checked {
  return {
    ...p,
    stages: p.stages.map((s, i) => ({ ...s, on_pass: s.on_pass ?? p.stages[i + 1]?.name ?? DONE })),
  };
}

function resolve(p: Checked): Pipeline {
  return {
    ...p,
    stages: p.stages.map((s) => ({
      ...s,
      require: s.require ?? "all",
    })),
  };
}

/** What zod's shape check cannot see: references between Stages, Agents and lanes, and loops. */
function checkMeaning(
  p: Checked,
  { agents: knownAgents, gates: knownGates }: PipelineOptions,
): string[] {
  const issues: string[] = [];
  const stageNames = p.stages.map((s) => s.name);
  const targets = [...stageNames, DONE].join(", ");
  const byName = new Map<string, CheckedStage>();
  for (const s of p.stages) {
    if (s.name === DONE) {
      issues.push(
        `stage "${DONE}": "${DONE}" is reserved for the end of the Pipeline, pick another name`,
      );
    } else if (byName.has(s.name)) {
      issues.push(`stage "${s.name}": duplicate stage name "${s.name}"`);
    } else {
      byName.set(s.name, s);
    }
  }
  const defaults = p.kinds[DEFAULT_KIND] ?? {};
  const checkAgents = (where: string, agents: string[]) => {
    if (!knownAgents) return;
    for (const a of agents) {
      if (!knownAgents.has(a)) issues.push(`${where}: ${unknownName("agent", a, knownAgents)}`);
    }
  };

  for (const s of p.stages) {
    const at = `stage "${s.name}"`;
    if (s.type === "agent" && !defaults[s.name]) {
      issues.push(
        `${at}: agent stages need an entry in [kinds.${DEFAULT_KIND}], e.g. ${s.name} = ["name"]`,
      );
    }
    if (s.type === "gate") {
      if (!s.gates) {
        issues.push(`${at}: gate stages need gates, e.g. gates = ["check_passes"]`);
      } else if (knownGates) {
        for (const g of s.gates) {
          if (!knownGates.has(g)) issues.push(`${at}: ${unknownName("gate", g, knownGates)}`);
        }
      }
    } else if (s.gates) {
      issues.push(`${at}: gates are only for gate stages, and this is a ${s.type} stage`);
    }
    if (s.require && s.type !== "agent") {
      issues.push(`${at}: require is only for agent stages, and this is a ${s.type} stage`);
    }

    if (s.on_pass !== DONE && !byName.has(s.on_pass)) {
      issues.push(`${at}: on_pass "${s.on_pass}" is not a stage (stages: ${targets})`);
    }
    if (s.on_fail === DONE) {
      issues.push(
        `${at}: on_fail cannot be "${DONE}", a failed Stage must send the Task to a Stage`,
      );
    } else if (!byName.has(s.on_fail)) {
      issues.push(`${at}: on_fail "${s.on_fail}" is not a stage (stages: ${targets})`);
    }
    for (const lane of s.lanes ?? []) {
      if (!(lane in p.lanes)) issues.push(`${at}: lane "${lane}" is not declared in [lanes]`);
    }
  }

  for (const [kind, byStage] of Object.entries(p.kinds)) {
    for (const [stageName, agents] of Object.entries(byStage)) {
      const stage = byName.get(stageName);
      if (!stage) {
        issues.push(
          `kinds.${kind}: "${stageName}" is not a stage (stages: ${stageNames.join(", ")})`,
        );
      } else if (stage.type !== "agent") {
        issues.push(
          `kinds.${kind}.${stageName}: "${stageName}" is a ${stage.type} stage, so it has no agents to choose`,
        );
      } else {
        checkAgents(`kinds.${kind}.${stageName}`, agents);
      }
    }
  }

  issues.push(...failLaneGaps(p, byName));
  issues.push(...passCycles(byName));
  return issues;
}

/**
 * A failed Stage sends the Task straight to its `on_fail` Stage, so that Stage must run in every
 * lane the failing Stage runs in. Otherwise the Task would land on a Stage its lane skips.
 */
function failLaneGaps(p: Checked, byName: Map<string, CheckedStage>): string[] {
  const declared = LANES.filter((lane) => lane in p.lanes);
  const issues: string[] = [];
  for (const s of p.stages) {
    const target = byName.get(s.on_fail);
    if (!target?.lanes) continue;
    for (const lane of s.lanes ?? declared) {
      if (lane in p.lanes && !target.lanes.includes(lane)) {
        issues.push(
          `stage "${s.name}": on_fail "${target.name}" does not run in the ${lane} lane, which "${s.name}" runs in`,
        );
      }
    }
  }
  return issues;
}

/**
 * Following `on_pass` from any Stage must end at `done`. A loop on the pass path means a Task that
 * keeps passing never finishes. Loops on the fail path are fine: the Breaker bounds them.
 */
function passCycles(byName: Map<string, CheckedStage>): string[] {
  const next = (name: string) => byName.get(name)?.on_pass;
  const issues: string[] = [];
  const settled = new Set<string>();
  for (const start of byName.keys()) {
    const path: string[] = [];
    let at: string | undefined = start;
    while (at !== undefined && at !== DONE && !settled.has(at)) {
      const seen = path.indexOf(at);
      if (seen >= 0) {
        const loop = [...path.slice(seen), at].join(" -> ");
        issues.push(`stages: cycle on the pass path (${loop}) that never reaches ${DONE}`);
        break;
      }
      path.push(at);
      at = next(at);
    }
    for (const name of path) settled.add(name);
  }
  return issues;
}
