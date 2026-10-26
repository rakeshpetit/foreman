import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli/main.ts";
import { parseAgent } from "../src/config/agent.ts";
import type { ResolvedConfig } from "../src/config/layers.ts";
import {
  DEFAULT_PIPELINE_PATH,
  loadPipeline,
  type Pipeline,
  parsePipeline,
} from "../src/config/pipeline.ts";
import type { Docker } from "../src/docker/docker.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import { Store } from "../src/store/store.ts";

/** The repo root and the fixture plan, resolved from this file, never from the working directory. */
export const REPO_ROOT = join(import.meta.dirname, "..");
export const FIXTURE_PLAN = join(import.meta.dirname, "fixtures", "plan");

const tmpDirs: string[] = [];

/** Makes a temp directory that `removeTmpDirs` deletes. Call `afterEach(removeTmpDirs)` in the test file. */
export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

export function removeTmpDirs(): void {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

const stores: Store[] = [];

/** Opens an in-memory Store that `closeStores` closes. Call `afterEach(closeStores)` in the test file. */
export function memoryStore(): Store {
  const store = Store.memory();
  stores.push(store);
  return store;
}

export function closeStores(): void {
  for (const store of stores.splice(0)) store.close();
}

/** A Request set to building with one Milestone (seq 1). */
export function buildingRequest(
  store: Store,
  request: Parameters<Store["createRequest"]>[0] = { title: "r", target_repo: "/r" },
  milestoneTitle = "m",
) {
  const r = store.createRequest(request);
  store.updateRequest(r.id, { phase: "building" });
  const m = store.createMilestone({ request_id: r.id, seq: 1, title: milestoneTitle });
  return { r, m };
}

/** foreman's default Pipeline. */
export function defaultPipeline() {
  return loadPipeline(DEFAULT_PIPELINE_PATH, {});
}

/**
 * A small Pipeline that tests can lean on without tracking `defaults/pipeline.toml`: one Stage of
 * each type, a fail that goes back to a Stage other than the one before, and a Workup the fast
 * lane skips.
 */
export function fixturePipeline(): Pipeline {
  return parsePipeline(`
[[stages]]
name = "workup"
type = "agent"
on_fail = "workup"
lanes = ["normal"]

[[stages]]
name = "red"
type = "gate"
gates = ["red_before"]
on_fail = "workup"
lanes = ["normal"]

[[stages]]
name = "implement"
type = "agent"
on_fail = "implement"

[[stages]]
name = "gates"
type = "gate"
gates = ["green_after", "check_passes", "test_integrity"]
on_fail = "implement"

[[stages]]
name = "review"
type = "agent"
require = "all"
on_fail = "implement"

[[stages]]
name = "task_approval"
type = "owner"
on_fail = "implement"

[[stages]]
name = "research"
type = "agent"
on_fail = "research"

[lanes.normal]

[lanes.fast]
under_lines = 30

[kinds.default]
workup = ["workup-agent"]
implement = ["implement-agent"]
review = ["review-agent-a", "review-agent-b"]
research = ["research-agent"]
`);
}

/** The Agents a Pipeline names, in its Kinds. */
function agentNamesOf(pipeline: Pipeline): Set<string> {
  const names = new Set<string>();
  for (const byStage of Object.values(pipeline.kinds)) {
    for (const agents of Object.values(byStage)) for (const a of agents) names.add(a);
  }
  return names;
}

/** What `agentExecutor` needs of a config: the Pipeline and `taskAgents`, with a stub Agent for each name it uses. */
export function stubConfig(
  pipeline: Pipeline,
  extra: string[] = [],
  taskAgents: ResolvedConfig["taskAgents"] = {},
) {
  const agents: ResolvedConfig["agents"] = new Map();
  for (const name of [...agentNamesOf(pipeline), ...extra]) {
    const path = `agents/${name}/AGENT.md`;
    const agent = parseAgent(
      "---\noutput:\n  verdicts: [PASS, FAIL, BLOCKED]\n---\nStub role prompt for {{task.id}}.\n",
      { source: path },
    );
    agents.set(name, { agent, path, source: "default" });
  }
  return { pipeline, taskAgents, agents, skillRoots: [] };
}

/**
 * `main` run against a fresh Target repo in a temp directory, with its own FOREMAN_HOME.
 * `env` is added to FOREMAN_HOME; `runner` replaces the default FakeRunner. With `docker`, `run`
 * gets no Runner, so `foreman run` builds its ContainerRunner on that Docker.
 */
export function cli(
  opts: { env?: Record<string, string>; runner?: FakeRunner; docker?: Docker } = {},
) {
  const root = tmpDir("foreman-e2e-");
  const home = join(root, "home");
  const out: string[] = [];
  const err: string[] = [];
  const runner = opts.runner ?? new FakeRunner();
  const run = (...argv: string[]) =>
    main(argv, {
      env: { FOREMAN_HOME: home, ...opts.env },
      cwd: root,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      runner: opts.docker ? undefined : runner,
      docker: opts.docker,
    });
  return { root, home, out, err, run, runner };
}
