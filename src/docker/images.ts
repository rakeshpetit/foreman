import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { FOREMAN_DIR } from "../config/skill.ts";
import { type Docker, DockerError, mustRun } from "./docker.ts";

export interface ImageSpec {
  /** The image tag. */
  name: string;
  /** The build context, relative to foreman's own checkout. */
  context: string;
}

export const BASE_IMAGE: ImageSpec = { name: "foreman-base", context: "images/base" };
export const PROXY_IMAGE: ImageSpec = {
  name: "foreman-egress-proxy",
  context: "images/egress-proxy",
};

export const IMAGES: ImageSpec[] = [BASE_IMAGE, PROXY_IMAGE];

/** Builds every image foreman ships, in order. Throws on the first failure. */
export async function buildImages(
  docker: Docker,
  opts: { foremanDir?: string; onBuilt?: (image: ImageSpec) => void } = {},
): Promise<void> {
  const foremanDir = opts.foremanDir ?? FOREMAN_DIR;
  for (const image of IMAGES) {
    await mustRun(docker, ["build", "--tag", image.name, join(foremanDir, image.context)]);
    opts.onBuilt?.(image);
  }
}

/** The Docker names that make up the egress setup. Overridable so a test can use its own. */
export interface Egress {
  /** `internal: true`: Agent containers live here and have no route out. */
  internalNetwork: string;
  /** The proxy's own way out. Agent containers are never on it. */
  outNetwork: string;
  proxyContainer: string;
  proxyImage: string;
}

export const EGRESS: Egress = {
  internalNetwork: "foreman-agents",
  outNetwork: "foreman-egress",
  proxyContainer: "foreman-egress-proxy",
  proxyImage: PROXY_IMAGE.name,
};

const PROXY_ALIAS = "proxy";
const PROXY_PORT = 8888;

/** The proxy variables an Agent container needs. Lower-case ones are for `curl`, which ignores upper-case HTTP_PROXY. */
export function proxyEnv(): Record<string, string> {
  const url = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    // Otherwise Claude Code tries to reach a telemetry host, which the proxy refuses.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/**
 * Makes sure both networks exist and the proxy is running on both, creating only what is missing.
 * Safe to call before every Run. The proxy image must already be built. Returns once the proxy accepts connections.
 */
export async function ensureEgress(docker: Docker, egress: Egress = EGRESS): Promise<void> {
  await ensureNetwork(docker, egress.internalNetwork, { internal: true });
  await ensureNetwork(docker, egress.outNetwork, { internal: false });

  const state = await proxyState(docker, egress.proxyContainer);
  const starting = !state?.running;
  if (!state) {
    await mustRun(docker, [
      "run",
      "--detach",
      "--name",
      egress.proxyContainer,
      "--network",
      egress.outNetwork,
      egress.proxyImage,
    ]);
  } else if (!state.running) {
    await mustRun(docker, ["start", egress.proxyContainer]);
  }
  if (!state?.networks.includes(egress.internalNetwork)) {
    await mustRun(docker, [
      "network",
      "connect",
      "--alias",
      PROXY_ALIAS,
      egress.internalNetwork,
      egress.proxyContainer,
    ]);
  }
  if (starting) await waitForProxy(docker, egress.proxyContainer);
}

/** Polls from inside the proxy container until it listens: `docker run --detach` returns before tinyproxy does. */
async function waitForProxy(docker: Docker, container: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = await docker.run([
      "exec",
      container,
      "nc",
      "-z",
      "127.0.0.1",
      String(PROXY_PORT),
    ]);
    if (probe.code === 0) return;
    await setTimeout(250);
  }
  throw new DockerError(`${container} did not start listening on port ${PROXY_PORT}`);
}

/**
 * Creates the network if it is missing. One that exists must already be `internal` when it has to be:
 * a `foreman-agents` made without `--internal` would let Agent containers reach out directly (ADR 0003).
 */
async function ensureNetwork(
  docker: Docker,
  name: string,
  { internal }: { internal: boolean },
): Promise<void> {
  const found = await docker.run(["network", "inspect", "--format", "{{.Internal}}", name]);
  if (found.code !== 0) {
    await mustRun(docker, ["network", "create", ...(internal ? ["--internal"] : []), name]);
    return;
  }
  if (internal && found.stdout.trim() !== "true") {
    throw new DockerError(
      `the Docker network ${name} exists but is not internal, so Agent containers could reach out directly: remove it with \`docker network rm ${name}\` and foreman recreates it`,
    );
  }
}

export interface ContainerState {
  running: boolean;
  networks: string[];
}

async function proxyState(docker: Docker, container: string): Promise<ContainerState | undefined> {
  const format =
    "{{.State.Running}}|{{range $name, $_ := .NetworkSettings.Networks}}{{$name}},{{end}}";
  const result = await docker.run(["container", "inspect", "--format", format, container]);
  if (result.code !== 0) return undefined;
  const [running, networks = ""] = result.stdout.trim().split("|");
  return { running: running === "true", networks: networks.split(",").filter(Boolean) };
}
