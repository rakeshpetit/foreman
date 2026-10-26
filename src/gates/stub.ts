import type { Gate, GateRegistry } from "./gate.ts";

const passes: Gate = () => ({ passed: true, detail: "stub: always passes" });

/** Every Gate the default Pipeline names, as stubs that pass. The real Gates arrive in M4. */
export const STUB_GATES: GateRegistry = {
  red_before: passes,
  green_after: passes,
  check_passes: passes,
  test_integrity: passes,
  diff_size: passes,
  evidence: passes,
};
