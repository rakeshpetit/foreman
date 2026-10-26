import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgent } from "../config/agent.ts";
import { parsePipeline } from "../config/pipeline.ts";
import { CliDocker, type Docker } from "../docker/docker.ts";
import { buildImages } from "../docker/images.ts";
import { agentExecutor } from "../engine/agent.ts";
import { ContainerRunner, tokenFileOf } from "../runner/container.ts";
import { foremanHome, type RunRow, Store } from "../store/store.ts";

const PIPELINE = parsePipeline(`
[[stages]]
name = "implement"
type = "agent"
on_fail = "implement"

[kinds.default]
implement = ["smoke"]
`);

const AGENT = `---
output:
  verdicts: [PASS, FAIL]
timeout: 10m
---

You are the smoke-test Agent for {{task.id}}. Do exactly this and nothing else:

1. Create \`hello.md\` in {{paths.workdir}} containing the single word \`hello\`.
2. Write a one-line report to {{paths.report}}.
3. Finish with the Verdict PASS.
`;

/** What a finished Run must have recorded for the row to be complete. */
const RECORDED = [
  "model",
  "verdict",
  "tokens_in",
  "tokens_out",
  "cache_read",
  "cache_write",
  "context_peak",
  "cost_usd",
  "duration_ms",
  "exit_code",
  "report_path",
] as const satisfies (keyof RunRow)[];

export interface SmokeOptions {
  docker: Docker;
  /** The subscription token: `claude.env` in `$FOREMAN_HOME`. */
  tokenFile: string;
  /** The `uid:gid` the container runs as. Default: the host user's. */
  user?: string;
  /** Where the scratch repo and raw output go. Default: the system temp directory. */
  tmp?: string;
  out: (line: string) => void;
}

/**
 * One real Run, end to end: builds the images, then runs a trivial Agent in a container on a
 * scratch repo, with nothing mocked but the Store, which is in memory. Returns the recorded row.
 * Throws if the Run fails, the Agent does not PASS or write `hello.md`, or the row is incomplete.
 * On a failure the scratch repo and the raw output are kept, and their paths printed, for diagnosis.
 */
export async function runSmoke({
  docker,
  tokenFile,
  user,
  tmp = tmpdir(),
  out,
}: SmokeOptions): Promise<RunRow> {
  await buildImages(docker, { onBuilt: (image) => out(`Built ${image.name}`) });

  const repo = mkdtempSync(join(tmp, "foreman-smoke-repo-"));
  const runsDir = mkdtempSync(join(tmp, "foreman-smoke-runs-"));
  const store = Store.memory();
  let passed = false;
  try {
    out(`repo: ${repo}`);
    const request = store.createRequest({ title: "smoke", target_repo: repo });
    store.updateRequest(request.id, { phase: "building" });
    const milestone = store.createMilestone({ request_id: request.id, seq: 1, title: "smoke" });
    const task = store.createTask({ milestone_id: milestone.id, seq: 1, title: "Write hello.md" });
    const taskFile = join(repo, ".foreman", request.id, "tasks", `${task.id}.md`);
    mkdirSync(join(taskFile, ".."), { recursive: true });
    writeFileSync(taskFile, "# Write hello.md\n\nSee your instructions.\n");

    const path = "agents/smoke/AGENT.md";
    const agents = new Map([
      ["smoke", { agent: parseAgent(AGENT, { source: path }), path, source: "default" as const }],
    ]);
    const stage = PIPELINE.stages[0];
    if (!stage) throw new Error("the smoke Pipeline has no Stage");
    const executor = agentExecutor({
      store,
      runner: new ContainerRunner({ docker, tokenFile, user }),
      runsDir,
      config: { pipeline: PIPELINE, taskAgents: {}, agents, skillRoots: [] },
    });
    const verdict = await executor(task, stage);

    const [row] = store.listRuns(task.id);
    if (!row) throw new Error("the Run left no row");
    for (const [key, value] of Object.entries(row)) out(`${key}: ${value}`);
    if (verdict !== "PASS") throw new Error(`the Agent returned ${verdict}, not PASS`);
    const unrecorded = RECORDED.filter((column) => row[column] == null);
    if (unrecorded.length > 0) throw new Error(`the row has no ${unrecorded.join(", ")}`);
    const hello = join(repo, "hello.md");
    if (!existsSync(hello)) throw new Error("the Agent passed but wrote no hello.md");
    out(`hello.md: ${readFileSync(hello, "utf8").trim()}`);
    passed = true;
    return row;
  } finally {
    store.close();
    if (passed) {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runsDir, { recursive: true, force: true });
    } else {
      out(`kept for diagnosis: ${repo} (worktree), ${runsDir} (raw output)`);
    }
  }
}

if (import.meta.main) {
  try {
    const row = await runSmoke({
      docker: new CliDocker(),
      tokenFile: tokenFileOf(foremanHome()),
      out: (l) => console.log(l),
    });
    console.log(
      row.verdict === "PASS" ? "Smoke test passed" : `Smoke test: verdict ${row.verdict}`,
    );
    process.exitCode = row.verdict === "PASS" ? 0 : 1;
  } catch (e) {
    console.error(`Smoke test failed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}
