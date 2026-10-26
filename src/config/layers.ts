import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Mode } from "../store/store.ts";
import { type Agent, loadAgent } from "./agent.ts";
import { type Pipeline, validatePipeline } from "./pipeline.ts";
import { FOREMAN_DIR, skillRoots } from "./skill.ts";

/** Top-level keys of a config layer that belong to the Pipeline. */
const PIPELINE_KEYS = ["stages", "kinds", "breaker", "notify", "lanes"] as const;

const settingsSchema = z.strictObject({
  mode: z.enum(["manual", "auto"]),
  check: z.string().min(1),
  run: z.string().min(1),
  healthcheck: z.string().min(1),
  e2e: z.string().min(1),
  e2e_red_before: z.boolean(),
});
const SETTING_KEYS = Object.keys(settingsSchema.shape);

const DEFAULT_MODE: Mode = "manual";

/** The Target repo's commands, as set in its `.foreman/config.toml`. */
export type Commands = Partial<Omit<z.output<typeof settingsSchema>, "mode">>;
/** Stage name → the Agents for it, replacing the Stage's own for one Task. */
export type TaskAgents = Record<string, string[]>;

/** What the Owner chose for one Request, normally at Go. The top layer. */
export interface RequestOverrides {
  id: string;
  mode?: Mode;
  /** Task id → Stage → Agents. */
  taskAgents?: Record<string, TaskAgents>;
}

export interface ConfigInput {
  targetRepo: string;
  request?: RequestOverrides;
  /** foreman's own checkout: its `defaults/pipeline.toml` and `agents/`. */
  foremanDir?: string;
  /** Every Gate name that exists, to catch a typo in `gates`. Unchecked when absent. */
  gates?: ReadonlySet<string>;
  /**
   * Check that every Agent a Stage names exists. Off until foreman ships its own Agent library,
   * since its default Pipeline names Agents that do not exist yet.
   */
  strictAgents?: boolean;
}

export interface LoadedAgent {
  agent: Agent;
  /** The AGENT.md file. */
  path: string;
  source: "default" | "target";
}

export interface ResolvedConfig {
  mode: Mode;
  commands: Commands;
  pipeline: Pipeline;
  agents: Map<string, LoadedAgent>;
  /** Where Skills are searched, most specific first. */
  skillRoots: string[];
  /** The Request's id, when one was given. */
  requestId: string | undefined;
  /** Per-Task Agent overrides chosen for the Request. */
  taskAgents: Record<string, TaskAgents>;
  /** Merged config key → the layer that set it. A key missing here comes from the defaults. */
  sources: Record<string, string>;
  /** What the layers were read from, for `config show`. */
  files: { defaults: string; target: string | undefined };
}

/** Every problem with the config layers, one readable line each (`issues`). */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("\n"));
    this.name = "ConfigError";
    this.issues = issues;
  }
}

type Table = Record<string, unknown>;

function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merges foreman's defaults, then the Target repo's `.foreman/` (config, Agents, Skill roots), then
 * the Request's overrides. Throws a `ConfigError`, `PipelineError` or `AgentError` naming the file
 * at fault.
 */
export function loadConfig(input: ConfigInput): ResolvedConfig {
  const foremanDir = input.foremanDir ?? FOREMAN_DIR;
  const defaultsPath = join(foremanDir, "defaults", "pipeline.toml");
  const targetPath = join(input.targetRepo, ".foreman", "config.toml");

  const defaults = readLayer(defaultsPath, "defaults/pipeline.toml");
  if (!defaults) throw new ConfigError([`${defaultsPath}: foreman's defaults are missing`]);
  const target = readLayer(targetPath, ".foreman/config.toml");

  const sources = new Map<string, string>();
  let merged: Table = {};
  merged = merge(merged, defaults, "default", sources);
  if (target) merged = merge(merged, target, "target", sources);

  const { pipelineRaw, settings } = splitSettings(merged);
  const request = input.request;
  let mode: Mode = settings.mode ?? DEFAULT_MODE;
  let modeSource = settings.mode === undefined ? "default" : (sources.get("mode") ?? "default");
  if (request?.mode) {
    mode = request.mode;
    modeSource = `request ${request.id}`;
  }
  const { mode: _mode, ...commands } = settings;

  const agents = loadAgents(foremanDir, input.targetRepo);
  const pipeline = validatePipeline(pipelineRaw, {
    source: "merged config",
    gates: input.gates,
    agents: input.strictAgents ? new Set(agents.keys()) : undefined,
  });
  const taskAgents = request?.taskAgents ?? {};
  checkTaskAgents(pipeline, taskAgents, request, input.strictAgents ? agents : undefined);

  const out: Record<string, string> = Object.fromEntries(sources);
  out.mode = modeSource;
  for (const [name, a] of agents) out[`agents.${name}`] = a.source;
  return {
    mode,
    commands,
    pipeline,
    agents,
    skillRoots: skillRoots({ targetRepo: input.targetRepo, foremanDir }),
    requestId: request?.id,
    taskAgents,
    sources: out,
    files: { defaults: defaultsPath, target: target ? targetPath : undefined },
  };
}

/** A parsed config file, or `undefined` when it does not exist. `label` is how errors name it. */
function readLayer(path: string, label: string): Table | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let raw: Table;
  try {
    raw = parseToml(text);
  } catch (e) {
    const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw new ConfigError([`${label}: not valid TOML: ${why}`]);
  }
  const known: string[] = [...PIPELINE_KEYS, ...SETTING_KEYS];
  const issues = Object.keys(raw)
    .filter((k) => !known.includes(k))
    .map((k) => `${label}: unknown key "${k}" (known: ${known.join(", ")})`);
  const settings = settingsSchema
    .partial()
    .safeParse(Object.fromEntries(Object.entries(raw).filter(([k]) => SETTING_KEYS.includes(k))));
  if (!settings.success) {
    for (const i of settings.error.issues)
      issues.push(`${label}: ${i.path.join(".")}: ${i.message}`);
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return raw;
}

/** Splits a merged layer into the Pipeline's tables and the other settings (already validated). */
function splitSettings(merged: Table) {
  const pipelineRaw: Table = {};
  const settings: Partial<z.output<typeof settingsSchema>> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (SETTING_KEYS.includes(k)) Object.assign(settings, { [k]: v });
    else pipelineRaw[k] = v;
  }
  return { pipelineRaw, settings };
}

/** Tables merge key by key; arrays and scalars replace. Every leaf it sets is recorded in `sources`. */
function merge(base: Table, over: Table, label: string, sources: Map<string, string>): Table {
  const mergeInto = (b: Table, o: Table, path: string[]): Table => {
    const out = { ...b };
    for (const [k, v] of Object.entries(o)) {
      const here = [...path, k];
      const existing = out[k];
      if (isTable(v) && isTable(existing)) {
        out[k] = mergeInto(existing, v, here);
      } else {
        out[k] = v;
        record(here, v);
      }
    }
    return out;
  };
  const record = (path: string[], value: unknown) => {
    const key = path.join(".");
    for (const k of [...sources.keys()])
      if (k === key || k.startsWith(`${key}.`)) sources.delete(k);
    if (isTable(value) && Object.keys(value).length > 0) {
      for (const [k, v] of Object.entries(value)) record([...path, k], v);
    } else {
      sources.set(key, label);
    }
  };
  return mergeInto(base, over, []);
}

/** Every `agents/<name>/AGENT.md` of foreman and of the Target repo. The Target repo wins by name. */
function loadAgents(foremanDir: string, targetRepo: string): Map<string, LoadedAgent> {
  const agents = new Map<string, LoadedAgent>();
  const issues: string[] = [];
  const dirs = [
    { dir: join(foremanDir, "agents"), source: "default", label: "agents" },
    { dir: join(targetRepo, ".foreman", "agents"), source: "target", label: ".foreman/agents" },
  ] as const;
  for (const { dir, source, label } of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!statSync(join(dir, name)).isDirectory()) continue;
      const path = join(dir, name, "AGENT.md");
      if (!existsSync(path)) {
        issues.push(`${label}/${name}: no AGENT.md in this folder`);
        continue;
      }
      agents.set(name, { agent: loadAgent(path), path, source });
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return agents;
}

function checkTaskAgents(
  pipeline: Pipeline,
  taskAgents: Record<string, TaskAgents>,
  request: RequestOverrides | undefined,
  known: ReadonlyMap<string, unknown> | undefined,
): void {
  const issues: string[] = [];
  const stages = new Map(pipeline.stages.map((s) => [s.name, s]));
  for (const [task, byStage] of Object.entries(taskAgents)) {
    const at = `request ${request?.id}: task ${task}`;
    for (const [stage, agents] of Object.entries(byStage)) {
      const s = stages.get(stage);
      if (!s) {
        issues.push(`${at}: "${stage}" is not a stage (stages: ${[...stages.keys()].join(", ")})`);
      } else if (s.type !== "agent") {
        issues.push(`${at}: "${stage}" is a ${s.type} stage, so it has no agents to choose`);
      } else if (known) {
        for (const a of agents) if (!known.has(a)) issues.push(`${at}: unknown agent "${a}"`);
      }
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
}

export interface ConfigEntry {
  key: string;
  value: unknown;
  /** `default`, `target`, or `request R-n`. */
  source: string;
}

/**
 * The resolved config as flat `key → value` entries with the layer each came from. Stage keys are
 * `stages.<name>.<field>`. `task` adds that Task's Agent overrides.
 */
export function describeConfig(
  config: ResolvedConfig,
  opts: { task?: string } = {},
): ConfigEntry[] {
  const lookup = (key: string): string => {
    for (let k = key; ; k = k.slice(0, k.lastIndexOf("."))) {
      const s = config.sources[k];
      if (s) return s;
      if (!k.includes(".")) return "default";
    }
  };
  const entries: ConfigEntry[] = [];
  const add = (key: string, value: unknown, source = lookup(key)) =>
    entries.push({ key, value, source });
  const walk = (key: string, value: unknown) => {
    if (isTable(value) && Object.keys(value).length > 0) {
      for (const [k, v] of Object.entries(value)) walk(`${key}.${k}`, v);
    } else {
      add(key, value);
    }
  };

  add("mode", config.mode);
  for (const [k, v] of Object.entries(config.commands)) add(k, v, config.sources[k] ?? "default");
  const { stages, ...rest } = config.pipeline;
  for (const s of stages) {
    const { name, ...fields } = s;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) add(`stages.${name}.${k}`, v, config.sources.stages ?? "default");
    }
  }
  for (const [k, v] of Object.entries(rest)) walk(k, v);
  for (const [name, a] of [...config.agents].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    add(`agents.${name}`, a.path, a.source);
  }
  const task = opts.task;
  if (task !== undefined) {
    for (const [stage, agents] of Object.entries(config.taskAgents[task] ?? {})) {
      add(`task.${task}.agents.${stage}`, agents, `request ${config.requestId}`);
    }
  }
  return entries;
}

/** `key = value  (source)` per line, with the keys aligned. */
export function formatEntries(entries: ConfigEntry[]): string {
  const width = Math.max(0, ...entries.map((e) => e.key.length));
  return entries
    .map((e) => `${e.key.padEnd(width)} = ${JSON.stringify(e.value)}  (${e.source})`)
    .join("\n");
}
