import type { TaskRow } from "../store/store.ts";

/** What a Gate found: whether the Task passed it, and why. No Agent's Verdict can override it. */
export interface GateResult {
  passed: boolean;
  detail: string;
}

/** A pass/fail condition foreman checks itself, with no Agent involved. */
export type Gate = (task: TaskRow) => Promise<GateResult> | GateResult;

/** Gate name → Gate. */
export type GateRegistry = Readonly<Record<string, Gate>>;
