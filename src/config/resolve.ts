import { z } from "zod";
import { STUB_GATES } from "../gates/stub.ts";
import type { RequestRow, Store, TaskRow } from "../store/store.ts";
import {
  ConfigError,
  loadConfig,
  type RequestOverrides,
  type ResolvedConfig,
  type TaskAgents,
} from "./layers.ts";

const taskAgentsSchema = z.record(z.string(), z.array(z.string().min(1)).min(1));

/** A Task's `agent_overrides` column as Stage → Agents. Empty when none were recorded. */
function parseTaskAgents(task: Pick<TaskRow, "id" | "agent_overrides">): TaskAgents {
  if (task.agent_overrides === null) return {};
  try {
    return taskAgentsSchema.parse(JSON.parse(task.agent_overrides));
  } catch {
    throw new ConfigError([
      `${task.id}: agent_overrides is not a {"<stage>": ["<agent>", ...]} object`,
    ]);
  }
}

/** The Request's own settings: its Mode, and the per-Task Agent overrides recorded on its Tasks. */
function requestOverrides(store: Store, request: RequestRow): RequestOverrides {
  const requestId = request.id;
  const taskAgents: NonNullable<RequestOverrides["taskAgents"]> = {};
  for (const m of store.listMilestones(requestId)) {
    for (const t of store.listTasks(m.id)) {
      taskAgents[t.id] = parseTaskAgents(t);
    }
  }
  return { id: requestId, mode: request.mode, taskAgents };
}

/** The Request's config, merged from foreman's defaults, its Target repo and its own overrides. */
export function resolveConfig(
  store: Store,
  request: RequestRow,
  foremanDir?: string,
): ResolvedConfig {
  return loadConfig({
    foremanDir,
    targetRepo: request.target_repo,
    request: requestOverrides(store, request),
    gates: new Set(Object.keys(STUB_GATES)),
  });
}

/** The resolved config of a Task's Request. */
export type ConfigFor = (task: TaskRow) => ResolvedConfig;

/**
 * Finds a Task's Request config, resolving it through `loadConfig` the first time one of its Tasks
 * is asked for and caching it from then on. `known` seeds the cache; `foremanDir` is `loadConfig`'s. Throws what `resolveConfig`
 * throws, and caches nothing for a Request whose config is broken.
 */
export function configResolver(
  store: Store,
  known: ReadonlyMap<string, ResolvedConfig> = new Map(),
  foremanDir?: string,
): ConfigFor {
  const cache = new Map(known);
  return (task) => {
    const milestone = store.getMilestone(task.milestone_id);
    const request = milestone && store.getRequest(milestone.request_id);
    if (!request) throw new Error(`no Request for task ${task.id}`);
    let config = cache.get(request.id);
    if (!config) {
      config = resolveConfig(store, request, foremanDir);
      cache.set(request.id, config);
    }
    return config;
  };
}
