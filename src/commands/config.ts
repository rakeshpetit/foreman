import { parseTaskAgents } from "../config/agents.ts";
import type { RequestOverrides } from "../config/layers.ts";
import { ConfigError, describeConfig, formatEntries, loadConfig } from "../config/layers.ts";
import { STUB_GATES } from "../engine/executors.ts";
import type { RequestRow, Store } from "../store/store.ts";

/** The Request's own settings: its Mode, and the per-Task Agent overrides recorded on its Tasks. */
function requestOverrides(store: Store, request: RequestRow): RequestOverrides {
  const requestId = request.id;
  const taskAgents: NonNullable<RequestOverrides["taskAgents"]> = {};
  for (const m of store.listMilestones(requestId)) {
    for (const t of store.listTasks(m.id)) {
      if (t.agent_overrides !== null) taskAgents[t.id] = parseTaskAgents(t);
    }
  }
  return { id: requestId, mode: request.mode, taskAgents };
}

/** `foreman config show R-n [--task T-n]`: the resolved config, one line per key with its source. */
export function showConfig(store: Store, requestId: string, opts: { task?: string } = {}): string {
  const request = store.getRequest(requestId);
  if (!request) throw new ConfigError([`Unknown request: ${requestId}`]);
  if (opts.task !== undefined) {
    const task = store.getTask(opts.task);
    const owner = task && store.getMilestone(task.milestone_id);
    if (owner?.request_id !== requestId) {
      throw new ConfigError([`${opts.task} is not a task of ${requestId}`]);
    }
  }
  const config = loadConfig({
    targetRepo: request.target_repo,
    request: requestOverrides(store, request),
    gates: new Set(Object.keys(STUB_GATES)),
  });
  const layers = [
    `defaults  ${config.files.defaults}`,
    `target    ${config.files.target ?? "(no .foreman/config.toml)"}`,
    `request   ${requestId}`,
  ];
  return [...layers, "", formatEntries(describeConfig(config, opts))].join("\n");
}
