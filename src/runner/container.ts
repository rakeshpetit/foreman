import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { type Docker, type DockerResult, tail } from "../docker/docker.ts";
import { BASE_IMAGE, EGRESS, type Egress, ensureEgress, proxyEnv } from "../docker/images.ts";
import {
  RunFailure,
  type RunFailureDetails,
  type RunFailureKind,
  type Runner,
  type RunResult,
  type RunSpec,
  type Usage,
} from "./runner.ts";

/** Where the worktree is mounted, and so where the Agent sees every path of its Run. */
const WORK = "/work";
const AGENT_HOME = "/home/agent";

/** Long enough for a real implement Run; an Agent sets its own with `timeout` in AGENT.md. */
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

/** How long to wait for `docker run` to return after `docker kill`, before `docker rm -f`. */
const KILL_GRACE_MS = 10_000;

export interface ContainerRunnerOptions {
  docker: Docker;
  /**
   * The subscription token: `claude.env` in `$FOREMAN_HOME` (`tokenFileOf`). The Skills a Run
   * mounts are staged in its folder.
   */
  tokenFile: string;
  /** The `uid:gid` the container runs as, so it can write the mounted worktree. Default: the host user's. */
  user?: string;
  /** For a Run whose Agent sets no image. */
  image?: string;
  /** For a Run whose Agent sets no `timeout`. */
  timeoutMs?: number;
  /** How long a killed container has to make `docker run` return before it is removed with `rm -f`. */
  killGraceMs?: number;
  egress?: Egress;
}

const numberOrZero = z.number().default(0);

/** The final `result` line of Claude's stream, as far as a Run needs it. */
const claudeOutput = z.object({
  is_error: z.boolean().default(false),
  api_error_status: z.number().nullish(),
  result: z.string().optional(),
  structured_output: z.object({ verdict: z.string() }).optional(),
  total_cost_usd: numberOrZero,
  usage: z
    .object({
      input_tokens: numberOrZero,
      output_tokens: numberOrZero,
      cache_read_input_tokens: numberOrZero,
      cache_creation_input_tokens: numberOrZero,
    })
    .default({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }),
  modelUsage: z.record(z.string(), z.object({ costUSD: z.number().optional() })).optional(),
});

/** One `assistant` line: the usage of one call to the model. */
const assistantLine = z.object({
  message: z.object({
    usage: z.object({
      input_tokens: numberOrZero,
      cache_read_input_tokens: numberOrZero,
      cache_creation_input_tokens: numberOrZero,
    }),
  }),
});

/** One `rate_limit_event` line: `resetsAt` is epoch seconds. */
const rateLimitLine = z.object({
  rate_limit_info: z.object({
    status: z.string(),
    resetsAt: z.number().optional(),
  }),
});

/** Any line of the stream: its `type` says which of the shapes above it is. */
const streamLine = z.object({ type: z.string() });

type ClaudeOutput = z.output<typeof claudeOutput>;

/** What one container launch needs: the same for `#runContainer` and `#dockerArgs`. */
interface Launch {
  /** The container's name. */
  name: string;
  /** The `--env-file` that holds the token. */
  tokenFile: string;
  /** The staged copy of the Skills, mounted as `.claude/skills`. Absent when the Run has none. */
  skillsDir?: string;
  spec: RunSpec;
}

/** A `rate_limit_info.status` that does not stop the Run: Claude warns of a nearing limit with `allowed_warning`. */
const LIMIT_OK = ["allowed", "allowed_warning"];

/**
 * Runs each Agent in a throwaway container (ADR 0003): `claude -p` as the host user in the worktree
 * mounted at `/work`, on the egress network, with the Skills copied in and the token from
 * `claude.env`. Claude prints `stream-json`: the Verdict comes from `structured_output` on its final
 * `result` line, the context peak from the `assistant` lines and a usage limit from the
 * `rate_limit_event` lines.
 *
 * Throws a `RunFailure` when the Run leaves no usable result. A missing token file is a setup
 * problem, not a Run's failure: that throws a plain `Error`.
 */
export class ContainerRunner implements Runner {
  readonly #opts: ContainerRunnerOptions;
  readonly #egress: Egress;

  constructor(opts: ContainerRunnerOptions) {
    this.#opts = opts;
    this.#egress = opts.egress ?? EGRESS;
  }

  async run(spec: RunSpec): Promise<RunResult> {
    const { docker, tokenFile } = this.#opts;
    await access(tokenFile).catch(() => {
      throw new Error(noToken(tokenFile));
    });
    await ensureEgress(docker, this.#egress);

    const skillsDir = await stageSkills(dirname(tokenFile), spec);
    try {
      const name = `foreman-run-${spec.runId}`;
      const stdout = await this.#runContainer({ name, tokenFile, skillsDir, spec });
      return parseResult(stdout, spec);
    } finally {
      if (skillsDir) await rm(skillsDir, { recursive: true, force: true });
    }
  }

  async #runContainer(launch: Launch): Promise<string> {
    const { name, spec } = launch;
    const { docker } = this.#opts;
    const timeoutMs = spec.timeoutMs ?? this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const running = docker.run(this.#dockerArgs(launch));
    // Whatever happens below, a late rejection of `running` is already handled.
    running.catch(() => {});

    // Aborting the timer once the race is over rejects `timedOut`, which the race already handles.
    const timer = new AbortController();
    const timedOut = setTimeout(timeoutMs, "timeout" as const, { signal: timer.signal });
    let outcome: DockerResult | "timeout";
    try {
      outcome = await Promise.race([running, timedOut]);
    } catch (error) {
      // `docker run` itself failed (output past maxBuffer, a signal): the container may still be there.
      const reason = error instanceof Error ? error.message : String(error);
      const gone = await removeContainer(docker, name);
      const left = gone ? "" : `; ${name} may still be running`;
      throw new RunFailure("failed", `docker run failed: ${reason}${left}`);
    } finally {
      timer.abort();
    }

    if (outcome === "timeout") {
      // The container may have just exited by itself, or `docker` may be down: a failed kill is not an error here.
      await docker.run(["kill", name]).catch(() => {});
      // `docker run` returns once the kill lands. If it does not within the grace period, remove the container.
      const graceMs = this.#opts.killGraceMs ?? KILL_GRACE_MS;
      const grace = new AbortController();
      // What `docker run` ended with, or `undefined` if it did not end within the grace period.
      const ended = await Promise.race([
        running.then(
          (r): { code?: number } => ({ code: r.code }),
          (): { code?: number } => ({}),
        ),
        setTimeout(graceMs, undefined, { signal: grace.signal }),
      ]).finally(() => grace.abort());
      const gone = ended !== undefined || (await removeContainer(docker, name));
      const left = gone
        ? ""
        : `; docker kill and rm -f did not stop it, ${name} may still be running`;
      throw new RunFailure("timeout", `timed out after ${timeoutMs} ms and was killed${left}`, {
        exitCode: ended?.code,
      });
    }
    if (outcome.code !== 0) {
      const run = readStream(outcome.stdout);
      const why = (run.output?.is_error && run.output.result) || tail(outcome.stderr);
      throw claudeFailure(run, `${name} exited ${outcome.code}: ${why}`, {
        stdout: outcome.stdout,
        exitCode: outcome.code,
      });
    }
    return outcome.stdout;
  }

  #dockerArgs({ name, tokenFile, skillsDir, spec }: Launch): string[] {
    const user = this.#opts.user ?? hostUser();
    const [uid, gid] = user.split(":");
    const owned = `rw,uid=${uid},gid=${gid},mode=700`;
    const env = { ...proxyEnv(), HOME: AGENT_HOME };
    const claude = [
      "claude",
      "-p",
      inContainer(spec.userPrompt, spec.workdir),
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify(spec.verdictSchema),
      "--append-system-prompt",
      inContainer(spec.systemPrompt, spec.workdir),
    ];
    if (spec.model) claude.push("--model", spec.model);
    if (spec.effort) claude.push("--effort", spec.effort);
    if (spec.tools) claude.push("--tools", spec.tools.join(","));

    return [
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      `foreman.run=${spec.runId}`,
      "--network",
      this.#egress.internalNetwork,
      "--user",
      user,
      "--env-file",
      tokenFile,
      ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      // The user has no home in the image, so give Claude a scratch one it owns. It dies with the container.
      // `.claude` is its own tmpfs: Docker would create it root-owned as the mount point for `skills`.
      "--tmpfs",
      `${AGENT_HOME}:${owned}`,
      "--tmpfs",
      `${AGENT_HOME}/.claude:${owned}`,
      "--volume",
      `${spec.workdir}:${WORK}`,
      ...(skillsDir ? ["--volume", `${skillsDir}:${AGENT_HOME}/.claude/skills:ro`] : []),
      "--workdir",
      WORK,
      spec.image ?? this.#opts.image ?? BASE_IMAGE.name,
      ...claude,
    ];
  }
}

/** The path of the subscription token file in `home`. */
export function tokenFileOf(home: string): string {
  return join(home, "claude.env");
}

/** What to do when the token file is missing. */
function noToken(tokenFile: string): string {
  return `no Claude token at ${tokenFile}: run \`claude setup-token\` and save CLAUDE_CODE_OAUTH_TOKEN=<token> there`;
}

/**
 * Checks that `ContainerRunner` can start a Run: the token file exists, `docker` is installed and
 * its daemon answers. Returns what to fix, or `undefined` when all is well. `foreman run` asks
 * before its first tick, so a Task is never marked `active` for a Run that cannot start.
 */
export async function preflight(docker: Docker, tokenFile: string): Promise<string | undefined> {
  try {
    await access(tokenFile);
  } catch {
    return noToken(tokenFile);
  }
  try {
    const { code, stderr } = await docker.run(["info", "--format", "{{.ServerVersion}}"]);
    if (code !== 0) {
      return `the Docker daemon is not running: start Docker and try again (${tail(stderr)})`;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return "docker is not installed, or not on PATH: install Docker and try again";
    }
    return `cannot talk to docker: ${e instanceof Error ? e.message : String(e)}`;
  }
  return undefined;
}

/**
 * `docker rm -f <name>`: stops and removes a container whose Run is over. True when it is gone,
 * including when Docker says there is no such container (`--rm` got there first).
 */
async function removeContainer(docker: Docker, name: string): Promise<boolean> {
  try {
    const { code, stderr } = await docker.run(["rm", "-f", name]);
    return code === 0 || /No such container/i.test(stderr);
  } catch {
    return false;
  }
}

function hostUser(): string {
  return `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
}

/** Copies every Skill into one fresh folder under `parent`, to mount as `.claude/skills`. */
async function stageSkills(parent: string, spec: RunSpec): Promise<string | undefined> {
  if (spec.skills.length === 0) return undefined;
  const dir = await mkdtemp(join(parent, "skills-"));
  for (const skill of spec.skills) {
    await cp(skill.dir, join(dir, skill.name), { recursive: true, dereference: true });
  }
  return dir;
}

/** The prompts name files by their host path; in the container the worktree is `/work`. */
function inContainer(prompt: string, workdir: string): string {
  const path = workdir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prompt.replace(new RegExp(`${path}(?![\\w.-])`, "g"), WORK);
}

/** What a Run needs from Claude's stream. */
interface ClaudeRun {
  /** The final `result` line. Absent if the stream has none. */
  output?: ClaudeOutput;
  /** The fullest context of any call to the model, in tokens. Null if the stream has no `assistant` line. */
  contextPeak: number | null;
  /** Every `rate_limit_event`, in order. */
  rateLimits: { status: string; resetsAt?: number }[];
}

/**
 * Reads Claude's `stream-json` output, one JSON object per line. A line that is not JSON, or not
 * one of the shapes below, is skipped: the stream also carries `system` and `user` lines.
 */
function readStream(stdout: string): ClaudeRun {
  const run: ClaudeRun = { contextPeak: null, rateLimits: [] };
  for (const line of stdout.split("\n")) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const type = streamLine.safeParse(json).data?.type;
    if (type === "result") {
      const output = claudeOutput.safeParse(json);
      if (output.success) run.output = output.data;
    } else if (type === "assistant") {
      const call = assistantLine.safeParse(json);
      if (call.success) {
        // The context a call sent is its input plus both caches.
        const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens } =
          call.data.message.usage;
        const context = input_tokens + cache_read_input_tokens + cache_creation_input_tokens;
        run.contextPeak = Math.max(run.contextPeak ?? 0, context);
      }
    } else if (type === "rate_limit_event") {
      const event = rateLimitLine.safeParse(json);
      if (event.success) run.rateLimits.push(event.data.rate_limit_info);
    }
  }
  return run;
}

/**
 * Why a Run failed. `auth` for a 401 or "Not logged in": the token is bad or expired
 * (docs/spikes/claude-in-container.md). `usage-limit` when the stream has a `rate_limit_event` whose
 * status is a limit, with that event's `resetsAt`. A stream with no such event (a Run's stream starts
 * with an `allowed` one, so the limit may never get its own) falls back to matching the `is_error`
 * text ("You've hit/reached your … limit"), which has no reset time. Any other error Claude reports,
 * or none, is `failed`.
 */
function failureOf({ output, rateLimits }: ClaudeRun): { kind: RunFailureKind; resetsAt?: Date } {
  if (output?.is_error) {
    const text = output.result ?? "";
    if (output.api_error_status === 401 || /Not logged in/.test(text)) return { kind: "auth" };
  }
  const hit = rateLimits.findLast((e) => !LIMIT_OK.includes(e.status));
  if (hit) {
    const resetsAt = hit.resetsAt === undefined ? undefined : new Date(hit.resetsAt * 1000);
    return { kind: "usage-limit", resetsAt };
  }
  const limitText = /\b(?:hit|reached) your\b.*\blimit/i.test(output?.result ?? "");
  return { kind: output?.is_error && limitText ? "usage-limit" : "failed" };
}

function claudeFailure(run: ClaudeRun, message: string, details: RunFailureDetails): RunFailure {
  const { kind, resetsAt } = failureOf(run);
  return new RunFailure(kind, message, { ...details, resetsAt });
}

function usageOf({ usage, total_cost_usd }: ClaudeOutput, contextPeak: number | null): Usage {
  return {
    tokens_in: usage.input_tokens,
    tokens_out: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
    context_peak: contextPeak,
    cost_usd: total_cost_usd,
  };
}

/** The model that did the work: the `modelUsage` entry that cost the most, not a cheap helper's. */
function mainModel(output: ClaudeOutput): string | undefined {
  let main: string | undefined;
  let top = -1;
  for (const [model, { costUSD = 0 }] of Object.entries(output.modelUsage ?? {})) {
    if (costUSD > top) {
      main = model;
      top = costUSD;
    }
  }
  return main;
}

function parseResult(stdout: string, spec: RunSpec): RunResult {
  const run = readStream(stdout);
  const { output } = run;
  if (!output) {
    const why = `claude's output has no result: ${tail(stdout).slice(0, 200)}`;
    throw new RunFailure("invalid-result", why, { stdout, exitCode: 0 });
  }
  const { is_error, result, structured_output } = output;
  const usage = usageOf(output, run.contextPeak);
  if (is_error) {
    throw claudeFailure(run, `claude reported an error: ${result}`, {
      stdout,
      usage,
      exitCode: 0,
    });
  }

  const allowed = spec.verdictSchema.properties.verdict.enum;
  const verdict = allowed.find((v) => v === structured_output?.verdict);
  if (!verdict) {
    const got = structured_output ? `Verdict ${structured_output.verdict}` : "no Verdict";
    const why = `${got} in the result; this Agent may give ${allowed.join(", ")}`;
    throw new RunFailure("invalid-result", why, { stdout, usage, exitCode: 0 });
  }
  const model = mainModel(output);
  return { verdict, reportPath: spec.reportPath, usage, ...(model && { model }), stdout };
}
