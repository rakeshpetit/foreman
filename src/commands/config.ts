import { ConfigError, describeConfig, formatEntries } from "../config/layers.ts";
import { resolveConfig } from "../config/resolve.ts";
import type { Store } from "../store/store.ts";

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
  const config = resolveConfig(store, request);
  const layers = [
    `defaults  ${config.files.defaults}`,
    `target    ${config.files.target ?? "(no .foreman/config.toml)"}`,
    `request   ${requestId}`,
  ];
  return [...layers, "", formatEntries(describeConfig(config, opts))].join("\n");
}
