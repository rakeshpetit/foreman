import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NtfyNotifier } from "./ntfy.ts";

export interface NtfyConfig {
  server: string;
  topic: string;
  usageTopic?: string;
}

/**
 * Reads the `[ntfy]` table (`server`, `topic`, `usage_topic`) from `$FOREMAN_HOME/config.toml`.
 * Only that table's plain string values are understood. M2-T03 replaces this with the full
 * config merge. Returns an empty object when the file is missing.
 */
export function readNtfyTable(home: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(join(home, "config.toml"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const table: Record<string, string> = {};
  let inNtfy = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (header) {
      inNtfy = header[1] === "ntfy";
      continue;
    }
    if (!inNtfy) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(#.*)?$/.exec(line);
    if (kv?.[1]) table[kv[1]] = kv[2] !== undefined ? unescapeBasic(kv[2]) : (kv[3] ?? "");
  }
  return table;
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(["\\])/g, "$1");
}

/** Config file values, overridden by FOREMAN_NTFY_SERVER, FOREMAN_NTFY_TOPIC and FOREMAN_NTFY_USAGE_TOPIC. */
export function loadNtfyConfig(home: string, env: NodeJS.ProcessEnv): NtfyConfig | undefined {
  const file = readNtfyTable(home);
  const server = env.FOREMAN_NTFY_SERVER || file.server;
  const topic = env.FOREMAN_NTFY_TOPIC || file.topic;
  if (!server || !topic) return undefined;
  const usageTopic = env.FOREMAN_NTFY_USAGE_TOPIC || file.usage_topic;
  return { server, topic, ...(usageTopic ? { usageTopic } : {}) };
}

export function ntfyFromConfig(home: string, env: NodeJS.ProcessEnv): NtfyNotifier | undefined {
  const config = loadNtfyConfig(home, env);
  return config && new NtfyNotifier(config);
}
