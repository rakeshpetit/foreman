export type Priority = "min" | "low" | "default" | "high" | "max";

/** `main` is the Owner's topic; `usage` carries Task summaries at low priority (ADR 0009). */
export type Channel = "main" | "usage";

export interface Notification {
  channel?: Channel;
  title: string;
  message: string;
  priority?: Priority;
  tags?: string[];
}

export interface Notifier {
  send(n: Notification): Promise<void>;
}

export const taskDone = (task: string, title: string): Notification => ({
  title: `Task done: ${task}`,
  message: title,
  channel: "usage",
  priority: "low",
  tags: ["white_check_mark"],
});

export const requestDone = (request: string, title: string): Notification => ({
  title: `Request done: ${request}`,
  message: title,
  priority: "high",
  tags: ["tada"],
});

export const engineError = (error: unknown): Notification => ({
  title: "Foreman engine error",
  message: error instanceof Error ? error.message : String(error),
  priority: "high",
  tags: ["rotating_light"],
});

/** Sends a notification, logging any failure instead of throwing, so the engine never stops for it. */
export async function notifySafely(
  notifier: Notifier,
  n: Notification,
  log: (msg: string) => void = console.error,
): Promise<void> {
  try {
    await notifier.send(n);
  } catch (e) {
    log(`notify failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
