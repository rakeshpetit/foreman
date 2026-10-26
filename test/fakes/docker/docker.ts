import type { Docker, DockerResult } from "../../../src/docker/docker.ts";
import type { ContainerState } from "../../../src/docker/images.ts";

/** The value after the first `flag` in `args`. */
export function flagValue(args: string[], flag: string): string | undefined {
  return args[args.indexOf(flag) + 1];
}

/** Every value of a repeatable `flag`, e.g. each `-v`. */
export function flagValues(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1] as string] : []));
}

/** One `assistant` line of the stream: a call to the model that sent this much context. */
export function assistantLine(usage: {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        ...usage,
      },
    },
  };
}

/** One `rate_limit_event` line. `resetsAt` is epoch seconds. */
export function rateLimitLine(status: string, resetsAt?: number): Record<string, unknown> {
  return {
    type: "rate_limit_event",
    rate_limit_info: { status, rateLimitType: "five_hour", ...(resetsAt && { resetsAt }) },
  };
}

/** The final `result` line: a passing result unless `fields` change it. */
export function resultLine(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"verdict":"PASS"}',
    structured_output: { verdict: "PASS" },
    usage: {
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 6,
    },
    total_cost_usd: 0.01,
    ...fields,
  };
}

/** What `claude -p --output-format stream-json --verbose` prints: one JSON object per line. */
export function claudeStream(lines: Record<string, unknown>[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

/**
 * A whole stream for one Run: `init`, one call to the model (a context of 13 tokens), any `extra`
 * lines (rate-limit events and so on), then a passing `result` unless `fields` change it.
 */
export function claudeResult(
  fields: Record<string, unknown> = {},
  extra: Record<string, unknown>[] = [],
): string {
  return claudeStream([
    { type: "system", subtype: "init" },
    assistantLine({ input_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 }),
    ...extra,
    resultLine(fields),
  ]);
}

/** An in-memory `docker` that knows only the commands the image, egress and Agent-run code issues. */
export class FakeDocker implements Docker {
  readonly calls: string[][] = [];
  /** Plays the `claude` inside an Agent container, given the `docker run` arguments. Absent: it passes. */
  claude: (args: string[]) => DockerResult | Promise<DockerResult> = () => ok(claudeResult());
  readonly #killed = new Map<string, () => void>();
  readonly networks = new Set<string>();
  /** The networks that are not `internal`. One made by `network create --internal` is not in here. */
  readonly openNetworks = new Set<string>();
  /** Make `docker kill` do nothing, as when the daemon is stuck. Only `rm -f` then stops a container. */
  ignoreKill = false;
  containers = new Map<string, ContainerState>();
  /** Make `docker info` fail, as when the daemon is not running. */
  daemonDown = false;
  /** Make the next command starting with these arguments fail. */
  failOn?: { prefix: string[]; stderr: string };

  async run(args: string[]): Promise<DockerResult> {
    this.calls.push(args);
    if (this.failOn?.prefix.every((a, i) => args[i] === a)) {
      const { stderr } = this.failOn;
      this.failOn = undefined;
      return { code: 1, stdout: "", stderr };
    }
    const [cmd, sub] = args;
    const name = args.at(-1) ?? "";
    if (cmd === "info") {
      if (this.daemonDown)
        return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
      return ok("27.0.0\n");
    }
    if (cmd === "build" || cmd === "exec") return ok();
    if (cmd === "network" && sub === "inspect") {
      if (!this.networks.has(name)) return no();
      return ok(args.includes("{{.Internal}}") ? `${!this.openNetworks.has(name)}\n` : "");
    }
    if (cmd === "network" && sub === "create") {
      this.networks.add(name);
      if (!args.includes("--internal")) this.openNetworks.add(name);
      return ok();
    }
    if (cmd === "network" && sub === "connect") {
      // `network connect --alias proxy <network> <container>`
      this.containers.get(name)?.networks.push(args.at(-2) ?? "");
      return ok();
    }
    if (cmd === "container" && sub === "inspect") {
      const c = this.containers.get(name);
      return c ? ok(`${c.running}|${c.networks.map((n) => `${n},`).join("")}\n`) : no();
    }
    if (cmd === "run" && args.includes("--rm")) return this.claude(args);
    if (cmd === "kill") {
      if (!this.ignoreKill) this.#killed.get(name)?.();
      return ok(`${name}\n`);
    }
    if (cmd === "rm" && sub === "-f") {
      this.#killed.get(name)?.();
      return ok(`${name}\n`);
    }
    if (cmd === "run") {
      this.containers.set(flagValue(args, "--name") ?? "", {
        running: true,
        networks: [flagValue(args, "--network") ?? ""],
      });
      return ok();
    }
    if (cmd === "start") {
      const c = this.containers.get(name);
      if (c) c.running = true;
      return ok();
    }
    throw new Error(`FakeDocker: unexpected command: docker ${args.join(" ")}`);
  }

  /** For `claude` to return: a container that runs on until `docker kill` or `docker rm -f` stops it (exit 137). */
  untilKilled(args: string[]): Promise<DockerResult> {
    const name = flagValue(args, "--name") ?? "";
    return new Promise((resolve) => {
      this.#killed.set(name, () => resolve({ code: 137, stdout: "", stderr: "" }));
    });
  }

  /** The calls whose first arguments match. */
  callsStarting(...prefix: string[]): string[][] {
    return this.calls.filter((c) => prefix.every((a, i) => c[i] === a));
  }
}

const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
const no = (): DockerResult => ({ code: 1, stdout: "", stderr: "Error: No such object" });
