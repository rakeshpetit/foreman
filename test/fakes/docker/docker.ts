import type { Docker, DockerResult } from "../../../src/docker/docker.ts";
import type { ContainerState } from "../../../src/docker/images.ts";

/** An in-memory `docker` that knows only the commands the image and egress code issues. */
export class FakeDocker implements Docker {
  readonly calls: string[][] = [];
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
    if (cmd === "run") {
      this.containers.set(args[args.indexOf("--name") + 1] ?? "", {
        running: true,
        networks: [args[args.indexOf("--network") + 1] ?? ""],
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

  /** The calls whose first arguments match. */
  callsStarting(...prefix: string[]): string[][] {
    return this.calls.filter((c) => prefix.every((a, i) => c[i] === a));
  }
}

const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
const no = (): DockerResult => ({ code: 1, stdout: "", stderr: "Error: No such object" });
