import assert from "node:assert/strict";
import { test } from "node:test";
import { version } from "../src/cli/main.ts";

test("version reads package.json", () => {
  assert.match(version(), /^\d+\.\d+\.\d+$/);
});
