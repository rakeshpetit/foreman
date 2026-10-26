import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Store } from "../store/store.ts";
import { parseTasks, planTitle } from "./parse.ts";

export interface ImportResult {
  requestId: string;
  milestones: number;
  tasks: number;
}

export function importPlan(store: Store, targetRepo: string, planDir: string): ImportResult {
  const repo = resolve(targetRepo);
  const planMd = readFileSync(join(planDir, "PLAN.md"), "utf8");
  const parsed = parseTasks(readFileSync(join(planDir, "TASKS.md"), "utf8"));

  const result = store.transaction(() => {
    const req = store.createRequest({ title: planTitle(planMd), target_repo: repo });
    const ids = new Map<string, string>();
    const files: { id: string; body: string }[] = [];
    let count = 0;
    parsed.milestones.forEach((pm, mi) => {
      const m = store.createMilestone({ request_id: req.id, seq: mi + 1, title: pm.title });
      pm.tasks.forEach((pt, ti) => {
        const t = store.createTask({
          milestone_id: m.id,
          seq: ti + 1,
          title: pt.title,
          ref: pt.ref,
          kind: pt.kind,
          size_est: pt.size,
          origin: "planned",
          stage: "workup",
          file_path: join(".foreman", req.id, "tasks", "TASK.md"),
        });
        ids.set(pt.ref, t.id);
        files.push({ id: t.id, body: pt.body });
        count++;
      });
    });
    for (const pm of parsed.milestones) {
      for (const pt of pm.tasks) {
        for (const d of pt.depends) {
          store.addDependency(ids.get(pt.ref) as string, ids.get(d) as string);
        }
      }
    }
    for (const f of files) {
      store.updateTask(f.id, { file_path: join(".foreman", req.id, "tasks", `${f.id}.md`) });
    }
    store.addEvent("request.imported", req.id, { tasks: count });
    return { req, files, count };
  });

  const base = join(repo, ".foreman", result.req.id);
  mkdirSync(join(base, "tasks"), { recursive: true });
  writeFileSync(join(base, "plan.md"), planMd);
  for (const f of result.files) writeFileSync(join(base, "tasks", `${f.id}.md`), f.body);
  return { requestId: result.req.id, milestones: parsed.milestones.length, tasks: result.count };
}
