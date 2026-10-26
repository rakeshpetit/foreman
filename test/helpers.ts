import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PIPELINE_PATH, loadPipeline } from "../src/config/pipeline.ts";
import type { Store } from "../src/store/store.ts";

/** The repo root and the fixture plan, resolved from this file, never from the working directory. */
export const REPO_ROOT = join(import.meta.dirname, "..");
export const FIXTURE_PLAN = join(import.meta.dirname, "fixtures", "plan");

const tmpDirs: string[] = [];

/** Makes a temp directory that `removeTmpDirs` deletes. Call `afterEach(removeTmpDirs)` in the test file. */
export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

export function removeTmpDirs(): void {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A Request set to building with one Milestone (seq 1). */
export function buildingRequest(
  store: Store,
  request: Parameters<Store["createRequest"]>[0] = { title: "r", target_repo: "/r" },
  milestoneTitle = "m",
) {
  const r = store.createRequest(request);
  store.updateRequest(r.id, { phase: "building" });
  const m = store.createMilestone({ request_id: r.id, seq: 1, title: milestoneTitle });
  return { r, m };
}

/** foreman's default Pipeline. */
export function defaultPipeline() {
  return loadPipeline(DEFAULT_PIPELINE_PATH, {});
}
