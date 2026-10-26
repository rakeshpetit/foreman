import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Docker, tail } from "../docker/docker.ts";
import { BASE_IMAGE, EGRESS, type Egress, ensureEgress, proxyEnv } from "../docker/images.ts";
import { RunFailure, type Runner, type RunResult, type RunSpec } from "./runner.ts";

/** Where the worktree is mounted, and so where the Agent sees every path of its Run. */
const WORK = "/work";
const AGENT_HOME = "/home/agent";

/** Long enough for a real implement Run; an Agent sets its own with `timeout` in AGENT.md. */
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

/** How long to wait for `docker run` to return after `docker kill`. */
const KILL_GRACE_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ContainerRunnerOptions {
  docker: Docker;
  /** `$FOREMAN_HOME`: holds `claude.env`, the subscription token. */
  home: string;
  /** The `uid:gid` the container runs as, so it can write the mounted worktree. Default: the host user's. */
  user?: string;
  /** For a Run whose Agent sets no image. */
  image?: string;
  /** For a Run whose Agent sets no `timeout`. */
  timeoutMs?: number;
  egress?: Egress;
}

/** What `claude -p --output-format json` prints, as far as a Run needs it. */
const claudeOutput = z.object({
  is_error: z.boolean().default(false),
  result: z.string().optional(),
  structured_output: z.object({ verdict: z.string() }).optional(),
  usage: z
    .object({ input_tokens: z.number().default(0), output_tokens: z.number().default(0) })
    .default({ input_tokens: 0, output_tokens: 0 }),
});

/**
 * Runs each Agent in a throwaway container (ADR 0003): `claude -p` as the host user in the worktree
 * mounted at `/work`, on the egress network, with the Skills copied in and the token from
 * `claude.env`. The Verdict comes from Claude's `structured_output`.
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
    const { docker, home } = this.#opts;
    const tokenFile = join(home, "claude.env");
    await access(tokenFile).catch(() => {
      throw new Error(
        `no Claude token at ${tokenFile}: run \`claude setup-token\` and save CLAUDE_CODE_OAUTH_TOKEN=<token> there`,
      );
    });
    await ensureEgress(docker, this.#egress);

    const skillsDir = await stageSkills(home, spec);
    try {
      const name = `foreman-run-${spec.runId}`;
      const stdout = await this.#runContainer(name, tokenFile, skillsDir, spec);
      return parseResult(stdout, spec);
    } finally {
      if (skillsDir) await rm(skillsDir, { recursive: true, force: true });
    }
  }

  async #runContainer(
    name: string,
    tokenFile: string,
    skillsDir: string | undefined,
    spec: RunSpec,
  ): Promise<string> {
    const { docker } = this.#opts;
    const timeoutMs = spec.timeoutMs ?? this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const running = docker.run(this.#dockerArgs(name, tokenFile, skillsDir, spec));

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([running, timedOut]).finally(() => clearTimeout(timer));

    if (outcome === "timeout") {
      // The container may have just exited by itself: a failed kill then is not an error.
      await docker.run(["kill", name]);
      // `docker run` returns once the kill lands; do not wait on it forever if the kill did not.
      await Promise.race([running.catch(() => {}), sleep(KILL_GRACE_MS)]);
      throw new RunFailure("timeout", `timed out after ${timeoutMs} ms and was killed`);
    }
    if (outcome.code !== 0) {
      const output = readOutput(outcome.stdout);
      const why = (output?.is_error && output.result) || tail(outcome.stderr);
      throw new RunFailure("failed", `${name} exited ${outcome.code}: ${why}`, outcome.stdout);
    }
    return outcome.stdout;
  }

  #dockerArgs(
    name: string,
    tokenFile: string,
    skillsDir: string | undefined,
    spec: RunSpec,
  ): string[] {
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
      "json",
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

function hostUser(): string {
  return `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
}

/** Copies every Skill into one fresh folder under `home`, to mount as `.claude/skills`. */
async function stageSkills(home: string, spec: RunSpec): Promise<string | undefined> {
  if (spec.skills.length === 0) return undefined;
  const dir = await mkdtemp(join(home, "skills-"));
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

/** Claude's output as a Run needs it, or why it is not that. */
function readOutput(stdout: string): z.output<typeof claudeOutput> | undefined {
  try {
    const parsed = claudeOutput.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parseResult(stdout: string, spec: RunSpec): RunResult {
  const invalid = (why: string) => new RunFailure("invalid-result", why, stdout);
  const output = readOutput(stdout);
  if (!output) throw invalid(`claude's output is not a result: ${tail(stdout).slice(0, 200)}`);
  const { is_error, result, structured_output, usage } = output;
  if (is_error) throw new RunFailure("failed", `claude reported an error: ${result}`, stdout);

  const allowed = spec.verdictSchema.properties.verdict.enum;
  const verdict = allowed.find((v) => v === structured_output?.verdict);
  if (!verdict) {
    const got = structured_output ? `Verdict ${structured_output.verdict}` : "no Verdict";
    throw invalid(`${got} in the result; this Agent may give ${allowed.join(", ")}`);
  }
  return { verdict, reportPath: spec.reportPath, usage };
}
