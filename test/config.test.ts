import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AgentError } from "../src/config/agent.ts";
import {
  ConfigError,
  type ConfigInput,
  describeConfig,
  formatEntries,
  loadConfig,
} from "../src/config/layers.ts";
import { PipelineError } from "../src/config/pipeline.ts";
import { removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);

const DEFAULTS = `
[[stages]]
name = "implement"
type = "agent"
agents = ["coder"]
on_fail = "implement"

[[stages]]
name = "review"
type = "agent"
agents = ["critic"]
on_fail = "implement"

[kinds.ui]
review = ["ui-critic"]

[breaker]
per_stage = 3
per_task = 6
`;

const AGENT = (extra = "") =>
  `---\nmodel: sonnet\n${extra}output:\n  file: report.md\n  verdicts: [PASS]\n---\nRole prompt.\n`;

function addAgent(root: string, name: string, text = AGENT()) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "AGENT.md"), text);
}

/** A foreman checkout and a Target repo in temp dirs. `defaults` and `target` are file contents. */
function world(opts: { defaults?: string; target?: string } = {}) {
  const base = tmpDir("foreman-config-");
  const foremanDir = join(base, "foreman");
  const targetRepo = join(base, "repo");
  mkdirSync(join(foremanDir, "defaults"), { recursive: true });
  mkdirSync(join(targetRepo, ".foreman"), { recursive: true });
  writeFileSync(join(foremanDir, "defaults", "pipeline.toml"), opts.defaults ?? DEFAULTS);
  if (opts.target !== undefined) {
    writeFileSync(join(targetRepo, ".foreman", "config.toml"), opts.target);
  }
  const load = (extra: Partial<ConfigInput> = {}) =>
    loadConfig({ foremanDir, targetRepo, ...extra });
  return { foremanDir, targetRepo, load };
}

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof Error);
    return e;
  }
  assert.fail("expected an error");
}

function sourceOf(config: ReturnType<typeof loadConfig>, key: string): string | undefined {
  return describeConfig(config).find((e) => e.key === key)?.source;
}

describe("loadConfig layers", () => {
  it("uses foreman's defaults when the Target repo has no config", () => {
    const w = world();
    const config = w.load();
    assert.equal(config.pipeline.breaker.per_task, 6);
    assert.equal(config.mode, "manual");
    assert.equal(sourceOf(config, "breaker.per_task"), "default");
    assert.equal(sourceOf(config, "mode"), "default");
  });

  it("lets the Target repo override a default, leaving the rest at default", () => {
    const w = world({ target: "[breaker]\nper_task = 9\n" });
    const config = w.load();
    assert.equal(config.pipeline.breaker.per_task, 9);
    assert.equal(config.pipeline.breaker.per_stage, 3);
    assert.equal(sourceOf(config, "breaker.per_task"), "target");
    assert.equal(sourceOf(config, "breaker.per_stage"), "default");
  });

  it("merges tables, replaces arrays, and adds Kinds the defaults lack", () => {
    const w = world({
      target: `[kinds.ui]\nimplement = ["ui-coder"]\n[kinds.infra]\nreview = ["ops-critic"]\n`,
    });
    const { pipeline } = w.load();
    assert.deepEqual(pipeline.kinds.ui, { review: ["ui-critic"], implement: ["ui-coder"] });
    assert.deepEqual(pipeline.kinds.infra, { review: ["ops-critic"] });
  });

  it("lets the Target repo replace the stages, naming it as the source of every stage key", () => {
    const w = world({
      defaults: DEFAULTS.replace('[kinds.ui]\nreview = ["ui-critic"]\n', ""),
      target: `[[stages]]\nname = "implement"\ntype = "agent"\nagents = ["solo"]\non_fail = "implement"\n`,
    });
    const config = w.load();
    assert.deepEqual(
      config.pipeline.stages.map((s) => s.name),
      ["implement"],
    );
    assert.equal(sourceOf(config, "stages.implement.agents"), "target");
    assert.equal(sourceOf(config, "stages.implement.require"), "target");
  });

  it("reads the Target repo's commands", () => {
    const w = world({ target: `check = "npm run check"\ne2e_red_before = true\n` });
    const config = w.load();
    assert.deepEqual(config.commands, { check: "npm run check", e2e_red_before: true });
    assert.equal(sourceOf(config, "check"), "target");
    assert.equal(sourceOf(config, "e2e_red_before"), "target");
  });

  it("lets a Request's Mode win over the Target repo's, and names the Request", () => {
    const w = world({ target: `mode = "manual"\n` });
    assert.equal(w.load().mode, "manual");
    assert.equal(sourceOf(w.load(), "mode"), "target");

    const config = w.load({ request: { id: "R-4", mode: "auto" } });
    assert.equal(config.mode, "auto");
    assert.equal(sourceOf(config, "mode"), "request R-4");
  });

  it("falls back to the Target repo's Mode when the Request sets none", () => {
    const w = world({ target: `mode = "auto"\n` });
    const config = w.load({ request: { id: "R-4" } });
    assert.equal(config.mode, "auto");
    assert.equal(sourceOf(config, "mode"), "target");
  });

  it("applies per-Task Agent overrides from the Request, shown only for the Task asked for", () => {
    const w = world();
    const config = w.load({
      request: { id: "R-4", taskAgents: { "T-2": { review: ["critic", "ui-critic"] } } },
    });
    assert.deepEqual(config.taskAgents["T-2"], { review: ["critic", "ui-critic"] });

    const shown = describeConfig(config, { task: "T-2" }).find(
      (e) => e.key === "task.T-2.agents.review",
    );
    assert.deepEqual(shown, {
      key: "task.T-2.agents.review",
      value: ["critic", "ui-critic"],
      source: "request R-4",
    });
    assert.equal(
      describeConfig(config).some((e) => e.key.startsWith("task.")),
      false,
    );
  });

  it("rejects a per-Task override of a stage that is not an agent stage", () => {
    const w = world({
      defaults: `${DEFAULTS}
[[stages]]
name = "gates"
type = "gate"
gates = ["check_passes"]
on_fail = "implement"
`,
    });
    for (const stage of ["gates", "nope"]) {
      const err = errorOf(() =>
        w.load({ request: { id: "R-4", taskAgents: { "T-2": { [stage]: ["critic"] } } } }),
      );
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, new RegExp(`request R-4: task T-2: .*"${stage}"`));
    }
  });
});

describe("loadConfig agents", () => {
  it("loads foreman's Agents and the Target repo's, the Target repo winning by name", () => {
    const w = world();
    addAgent(join(w.foremanDir, "agents"), "coder");
    addAgent(join(w.foremanDir, "agents"), "critic");
    addAgent(join(w.targetRepo, ".foreman", "agents"), "critic", AGENT("effort: high\n"));
    addAgent(join(w.targetRepo, ".foreman", "agents"), "extra");
    const config = w.load();
    assert.deepEqual([...config.agents.keys()].sort(), ["coder", "critic", "extra"]);
    assert.equal(config.agents.get("critic")?.agent.effort, "high");
    assert.equal(sourceOf(config, "agents.critic"), "target");
    assert.equal(sourceOf(config, "agents.coder"), "default");
    assert.equal(sourceOf(config, "agents.extra"), "target");
  });

  it("names the file of a broken AGENT.md", () => {
    const w = world();
    addAgent(join(w.targetRepo, ".foreman", "agents"), "bad", "no frontmatter\n");
    const err = errorOf(() => w.load());
    assert.ok(err instanceof AgentError);
    assert.match(err.message, /agents\/bad\/AGENT\.md/);
  });

  it("rejects an Agent folder with no AGENT.md", () => {
    const w = world();
    mkdirSync(join(w.targetRepo, ".foreman", "agents", "empty"), { recursive: true });
    const err = errorOf(() => w.load());
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /agents\/empty.*no AGENT\.md/);
  });

  it("checks Agent names only when strictAgents is set", () => {
    const w = world();
    assert.doesNotThrow(() => w.load());
    const err = errorOf(() => w.load({ strictAgents: true }));
    assert.ok(err instanceof PipelineError);
    assert.match(err.message, /unknown agent "coder"/);

    addAgent(join(w.targetRepo, ".foreman", "agents"), "coder");
    addAgent(join(w.targetRepo, ".foreman", "agents"), "critic");
    addAgent(join(w.targetRepo, ".foreman", "agents"), "ui-critic");
    assert.doesNotThrow(() => w.load({ strictAgents: true }));
  });

  it("gives skill roots with the Target repo's first", () => {
    const w = world();
    const roots = w.load().skillRoots;
    assert.equal(roots[0], join(w.targetRepo, ".foreman", "skills"));
    assert.equal(roots[1], join(w.foremanDir, "skills"));
  });
});

describe("loadConfig errors", () => {
  it("names the Target repo's config file when it is not valid TOML", () => {
    const w = world({ target: "breaker = [" });
    const err = errorOf(() => w.load());
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /\.foreman\/config\.toml: not valid TOML/);
  });

  it("names the file and key of an unknown top-level key", () => {
    const w = world({ target: `chek = "npm test"\n` });
    const err = errorOf(() => w.load());
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /\.foreman\/config\.toml: unknown key "chek"/);
  });

  it("names the file and key of a bad command", () => {
    const w = world({ target: `check = 3\n` });
    const err = errorOf(() => w.load());
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /\.foreman\/config\.toml: check:/);
  });

  it("reports a pipeline that is broken once the layers are merged", () => {
    const w = world({ target: `[kinds.ui]\nnope = ["x"]\n` });
    const err = errorOf(() => w.load());
    assert.ok(err instanceof PipelineError);
    assert.match(err.message, /kinds\.ui: "nope" is not a stage/);
  });
});

describe("formatEntries", () => {
  it("prints one aligned line per key with its source", () => {
    const w = world({ target: `check = "npm test"\n[breaker]\nper_task = 9\n` });
    const text = formatEntries(describeConfig(w.load({ request: { id: "R-4", mode: "auto" } })));
    const lines = text.split("\n");
    const find = (key: string) => lines.find((l) => l.startsWith(`${key} `));
    assert.match(find("mode") ?? "", /^mode\s+= "auto"\s+\(request R-4\)$/);
    assert.match(find("check") ?? "", /^check\s+= "npm test"\s+\(target\)$/);
    assert.match(find("breaker.per_task") ?? "", /^breaker\.per_task\s+= 9\s+\(target\)$/);
    assert.match(find("breaker.per_stage") ?? "", /^breaker\.per_stage\s+= 3\s+\(default\)$/);
    assert.match(find("stages.review.agents") ?? "", /= \["critic"\]\s+\(default\)$/);
  });
});
