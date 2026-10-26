import * as nodeFs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Store } from "../store/store.ts";
import { parseTasks, planTitle } from "./parse.ts";

export interface ImportResult {
  requestId: string;
  milestones: number;
  tasks: number;
}

/** The file operations import uses to write `.foreman/R-n/`; tests swap them to inject failures. */
export interface ImportFs {
  mkdirSync: typeof nodeFs.mkdirSync;
  writeFileSync: typeof nodeFs.writeFileSync;
  renameSync: typeof nodeFs.renameSync;
  rmSync: typeof nodeFs.rmSync;
  rmdirSync: typeof nodeFs.rmdirSync;
}

/**
 * Import is all-or-nothing. Inside the transaction the files are written to a staging
 * directory and renamed into place just before COMMIT, so the only step after the rename
 * is the commit, and a failed commit is undone by removing the renamed directory. A `.foreman/`
 * that this import created is removed too, so a failed import leaves the Target repo as it was.
 */
export function importPlan(
  store: Store,
  targetRepo: string,
  planDir: string,
  fs: ImportFs = nodeFs,
): ImportResult {
  const repo = resolve(targetRepo);
  const planMd = readFileSync(join(planDir, "PLAN.md"), "utf8");
  const parsed = parseTasks(readFileSync(join(planDir, "TASKS.md"), "utf8"));

  const dotForeman = join(repo, ".foreman");
  const madeDotForeman = !existsSync(dotForeman);
  let staging: string | undefined;
  let final: string | undefined;
  let renamed = false;
  try {
    const result = store.transaction(() => {
      const req = store.createRequest({ title: planTitle(planMd), target_repo: repo });
      const ids = new Map<string, string>();
      const files: { id: string; body: string }[] = [];
      parsed.milestones.forEach((pm, mi) => {
        const m = store.createMilestone({ request_id: req.id, seq: mi + 1, title: pm.title });
        pm.tasks.forEach((pt, ti) => {
          const t = store.createTask({
            milestone_id: m.id,
            seq: ti + 1,
            title: pt.title,
            ref: pt.ref,
            kind: pt.kind,
            size_est: pt.size_est,
            origin: "planned",
            file_path: (id) => join(".foreman", req.id, "tasks", `${id}.md`),
          });
          ids.set(pt.ref, t.id);
          files.push({ id: t.id, body: pt.body });
        });
      });
      for (const pm of parsed.milestones) {
        for (const pt of pm.tasks) {
          for (const d of pt.depends) {
            store.addDependency(ids.get(pt.ref) as string, ids.get(d) as string);
          }
        }
      }
      store.addEvent("request.imported", req.id, { tasks: files.length });

      final = join(dotForeman, req.id);
      staging = `${final}.staging`;
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(join(staging, "tasks"), { recursive: true });
      fs.writeFileSync(join(staging, "plan.md"), planMd);
      for (const f of files) fs.writeFileSync(join(staging, "tasks", `${f.id}.md`), f.body);
      fs.renameSync(staging, final);
      renamed = true;
      return { requestId: req.id, tasks: files.length };
    });
    return { ...result, milestones: parsed.milestones.length };
  } catch (e) {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    if (renamed && final) fs.rmSync(final, { recursive: true, force: true });
    // Not recursive: only an empty `.foreman/` goes, never anything else in the Target repo.
    if (madeDotForeman && existsSync(dotForeman)) fs.rmdirSync(dotForeman);
    throw e;
  }
}
