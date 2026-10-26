import type { Notification, Notifier } from "./notifier.ts";

export interface NtfyOptions {
  server: string;
  topic: string;
  /** Topic for Task summaries (ADR 0009). Defaults to `foreman-usage`. */
  usageTopic?: string;
  /** Abort a publish that has not finished in this long. Defaults to 5000. */
  timeoutMs?: number;
}

export const DEFAULT_USAGE_TOPIC = "foreman-usage";
export const DEFAULT_TIMEOUT_MS = 5000;

export class NtfyNotifier implements Notifier {
  readonly #base: string;
  readonly #topic: string;
  readonly #usageTopic: string;
  readonly #timeoutMs: number;

  constructor({ server, topic, usageTopic, timeoutMs }: NtfyOptions) {
    this.#base = server.replace(/\/+$/, "");
    this.#topic = topic;
    this.#usageTopic = usageTopic ?? DEFAULT_USAGE_TOPIC;
    this.#timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(n: Notification): Promise<void> {
    const topic = n.channel === "usage" ? this.#usageTopic : this.#topic;
    const headers: Record<string, string> = { Title: n.title };
    if (n.priority) headers.Priority = n.priority;
    if (n.tags?.length) headers.Tags = n.tags.join(",");
    const res = await fetch(`${this.#base}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers,
      body: n.message,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
  }
}
