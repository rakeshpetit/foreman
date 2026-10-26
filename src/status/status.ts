import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store/store.ts";

/** STATUS.md as a pure function of the database. */
export function render(store: Store): string {
  const out: string[] = ["# Foreman status", ""];

  const q = store.queueState();
  const until = q.paused_until ? `until ${q.paused_until}` : "(until resumed)";
  out.push(
    store.isPaused()
      ? `**Queue:** paused ${until}${q.reason ? ` (${q.reason})` : ""}`
      : "**Queue:** running",
    "",
  );

  const tasks = store.listTasks();
  const milestones = store.listMilestones();

  out.push("## Requests", "");
  const requests = store.listRequests();
  if (requests.length === 0) out.push("_none_");
  for (const r of requests) {
    out.push(`### ${r.id} · ${r.title}`, "", `Phase: ${r.phase} · Mode: ${r.mode}`, "");
    for (const m of milestones.filter((m) => m.request_id === r.id)) {
      const mine = tasks.filter((t) => t.milestone_id === m.id);
      const done = mine.filter((t) => t.status === "done").length;
      out.push(`- ${m.id} ${m.title}: ${done}/${mine.length} tasks done`);
    }
    out.push("");
  }

  out.push("## Tasks", "");
  if (tasks.length === 0) out.push("_none_", "");
  else {
    out.push("| Task | Title | Stage | Round | Origin | Status |", "|---|---|---|---|---|---|");
    for (const t of tasks) {
      out.push(
        `| ${t.id} | ${t.title} | ${t.stage ?? "-"} | ${t.round_total} | ${t.origin} | ${t.status} |`,
      );
    }
    out.push("");
  }

  out.push("## Waiting on the Owner", "");
  const waiting = [
    ...store
      .listApprovals("pending")
      .map((a) => `- ${a.id}: ${a.kind} approval for ${a.subject_id}`),
    ...tasks.filter((t) => t.status === "awaiting_owner").map((t) => `- ${t.id}: ${t.title}`),
  ];
  out.push(...(waiting.length ? waiting : ["_nothing_"]), "");

  out.push("## Recent events", "");
  const events = store.listEvents(10);
  if (events.length === 0) out.push("_none_");
  for (const e of events) out.push(`- ${e.at} ${e.type}${e.subject ? ` ${e.subject}` : ""}`);

  return `${out.join("\n")}\n`;
}

/** Writes STATUS.md via a temp file and rename, so readers never see a half-written file. */
export function writeStatus(store: Store, home: string): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, "STATUS.md");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, render(store));
  renameSync(tmp, path);
  return path;
}
