import type { Notification, Notifier } from "./notifier.ts";

export interface NtfyOptions {
  server: string;
  topic: string;
}

export class NtfyNotifier implements Notifier {
  readonly #url: string;

  constructor({ server, topic }: NtfyOptions) {
    this.#url = `${server.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
  }

  async send(n: Notification): Promise<void> {
    const headers: Record<string, string> = { Title: n.title };
    if (n.priority) headers.Priority = n.priority;
    if (n.tags?.length) headers.Tags = n.tags.join(",");
    const res = await fetch(this.#url, { method: "POST", headers, body: n.message });
    if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
  }
}
