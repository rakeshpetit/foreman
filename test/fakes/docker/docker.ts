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

/** What `claude -p` prints with `--output-format json`: a passing result unless `fields` change it. */
export function claudeResult(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
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
  });
}

/** An in-memory `docker` that knows only the commands the image, egress and Agent-run code issues. */
export class FakeDocker implements Docker {
  readonly calls: string[][] = [];
  /** Plays the `claude` inside an Agent container, given the `docker run` arguments. Absent: it passes. */
  claude: (args: string[]) => DockerResult | Promise<DockerResult> = () => ok(claudeResult());
  readonly #killed = new Map<string, () => void>();
  readonly networks = new Set<string>();
  containers = new Map<string, ContainerState>();
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
    if (cmd === "build" || cmd === "exec") return ok();
    if (cmd === "network" && sub === "inspect") return this.networks.has(name) ? ok() : no();
    if (cmd === "network" && sub === "create") {
      this.networks.add(name);
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

  /** For `claude` to return: a container that runs on until `docker kill` stops it (exit 137). */
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
