import { readFileSync } from "node:fs";
import { z } from "zod";
import { agentsFor } from "../config/agents.ts";
import type { ResolvedConfig } from "../config/layers.ts";
import type { StageConfig } from "../config/pipeline.ts";
import type { BlockingFinding, PriorReport } from "../runner/prompt.ts";
import type { RunRow, Store, TaskRow } from "../store/store.ts";
import type { Verdict } from "./verdict.ts";

type FinishedRun = RunRow & { verdict: Verdict; report_path: string };

/** The Task's Runs that ended with a Verdict and left a report, oldest first. */
function finishedRuns(store: Store, taskId: string): FinishedRun[] {
  return store.listRuns(taskId).flatMap((run) => {
    const { ended_at, verdict, report_path } = run;
    return ended_at && verdict && report_path ? [{ ...run, verdict, report_path }] : [];
  });
}

/** The reports the Task's earlier Runs left behind, oldest first. */
export function priorReports(store: Store, taskId: string): PriorReport[] {
  return finishedRuns(store, taskId).map(({ stage, agent, verdict, report_path }) => ({
    stage,
    agent: agent ?? stage,
    verdict,
    path: report_path,
  }));
}

const roundPayload = z.object({ stage: z.string() });

/**
 * What blocks `task` from passing `stage`: the reports of the Runs that failed the Stage that
 * caused the Task's last Round. Only the Stage that Round sent the Task back to gets them; a later
 * Stage sees those reports as earlier ones and nothing more. A failed Gate leaves no Run, so it
 * adds none. Call it before the Stage's own Runs start: it takes the newest Runs of the failed Stage.
 */
export function blockingFindings(
  store: Store,
  config: Pick<ResolvedConfig, "pipeline" | "taskAgents">,
  task: TaskRow,
  stage: StageConfig,
): BlockingFinding[] {
  const round = store.latestEvent("round.started", task.id);
  if (!round?.payload) return [];
  const failed = roundPayload.safeParse(JSON.parse(round.payload));
  const caused = failed.success && config.pipeline.stages.find((s) => s.name === failed.data.stage);
  if (!caused || caused.on_fail !== stage.name || caused.type !== "agent") return [];

  // A failed pass ran every Agent of the Stage, so its Runs are the last `n` finished ones.
  const n = agentsFor(config, task, caused).length;
  return finishedRuns(store, task.id)
    .slice(-n)
    .filter((r) => r.stage === caused.name && r.verdict === "FAIL")
    .map((r) => ({
      from: r.agent ? { agent: r.agent } : { stage: r.stage },
      text: readReport(r.report_path),
    }));
}

function readReport(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return `(the report at ${path} could not be read)`;
  }
}
