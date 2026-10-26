import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentError, loadAgent, parseAgent, TEMPLATE_VARIABLES } from "../src/config/agent.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/agents/implementer-tdd/AGENT.md");

const MINIMAL = `---
output:
  verdicts: [PASS, FAIL]
---
Do the work.
`;

function errorOf(text: string, source = "agents/x/AGENT.md"): AgentError {
  try {
    parseAgent(text, { source });
  } catch (e) {
    assert.ok(e instanceof AgentError, `expected an AgentError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected the Agent to be rejected");
}

describe("loadAgent", () => {
  it("parses a fixture Agent", () => {
    const a = loadAgent(FIXTURE);
    assert.equal(a.name, "implementer-tdd");
    assert.equal(a.model, "sonnet");
    assert.equal(a.effort, "high");
    assert.equal(a.image, "foreman-base");
    assert.deepEqual(a.tools, ["Read", "Edit", "Write", "Bash"]);
    assert.deepEqual(a.skills, { preload: ["tdd", "handoff"], available: ["diagnose"] });
    assert.deepEqual(a.output, { verdicts: ["PASS", "BLOCKED", "SCOPE_CHANGE"] });
    assert.equal(a.timeout, "45m");
    assert.equal(a.max_tokens, 400000);
    assert.match(a.body.trim(), /^# Implementer/);
    assert.match(a.body, /\{\{task\.id\}\}/);
  });
});

describe("parseAgent", () => {
  it("fills in defaults for everything optional", () => {
    const a = parseAgent(MINIMAL, { source: "a/AGENT.md" });
    assert.deepEqual(a.skills, { preload: [], available: [] });
    assert.equal(a.model, undefined);
    assert.equal(a.tools, undefined);
    assert.equal(a.body, "Do the work.\n");
  });

  it("takes the Agent's name from its folder", () => {
    assert.equal(parseAgent(MINIMAL, { source: "agents/critic-a/AGENT.md" }).name, "critic-a");
  });

  it("rejects an empty Verdict list, naming the file", () => {
    const e = errorOf(MINIMAL.replace("[PASS, FAIL]", "[]"));
    assert.match(e.message, /^agents\/x\/AGENT\.md: output\.verdicts: /);
  });

  it("rejects an Agent with no output contract", () => {
    const e = errorOf("---\nmodel: opus\n---\nbody\n");
    assert.match(e.message, /agents\/x\/AGENT\.md: output: /);
  });

  it("rejects an unknown template variable, naming the file and the line", () => {
    const e = errorOf(`${MINIMAL}\nSee {{task.colour}}.\n`);
    assert.match(e.message, /^agents\/x\/AGENT\.md: line 7: unknown variable "task\.colour"/);
    assert.match(e.message, /task\.id/, "lists what is known");
  });

  it("rejects an unknown variable namespace", () => {
    assert.match(errorOf(`${MINIMAL}{{owner.name}}`).message, /unknown variable "owner\.name"/);
  });

  it("rejects a malformed {{ }} expression", () => {
    assert.match(errorOf(`${MINIMAL}{{ task.id | upper }}`).message, /not a variable/);
  });

  it("accepts every documented variable, with or without spaces", () => {
    const vars = Object.entries(TEMPLATE_VARIABLES).flatMap(([ns, keys]) =>
      keys.map((k) => `{{${ns}.${k}}} {{ ${ns}.${k} }}`),
    );
    parseAgent(`${MINIMAL}${vars.join("\n")}\n`, { source: "a/AGENT.md" });
  });

  it("rejects a duplicate Verdict", () => {
    assert.match(errorOf(MINIMAL.replace("[PASS, FAIL]", "[PASS, PASS]")).message, /once/);
  });

  it("rejects a Verdict foreman does not know, naming the file and the known Verdicts", () => {
    for (const bad of ["MAYBE", "pass"]) {
      const e = errorOf(MINIMAL.replace("[PASS, FAIL]", `[PASS, ${bad}]`));
      assert.match(e.message, /^agents\/x\/AGENT\.md: output\.verdicts\[1\]: /);
      assert.match(e.message, /PASS, FAIL, BLOCKED, SCOPE_CHANGE/);
    }
  });

  it("rejects an Output contract without PASS, naming the file", () => {
    const e = errorOf(MINIMAL.replace("[PASS, FAIL]", "[FAIL, BLOCKED]"));
    assert.match(e.message, /^agents\/x\/AGENT\.md: output\.verdicts: list PASS/);
  });

  it("rejects output.file: foreman chooses where each Run's report goes", () => {
    assert.match(
      errorOf(MINIMAL.replace("output:\n", "output:\n  file: report.md\n")).message,
      /file/,
    );
  });

  it("checks timeout is a duration", () => {
    parseAgent(MINIMAL.replace("---\nDo", "timeout: 90s\n---\nDo"), { source: "a/AGENT.md" });
    const bad = errorOf(MINIMAL.replace("---\nDo", "timeout: banana\n---\nDo"));
    assert.match(bad.message, /timeout/);
  });

  it("rejects a {{ with no }} and a variable split over two lines", () => {
    assert.match(errorOf(`${MINIMAL}{{task.id}\n`).message, /no closing/);
    assert.match(errorOf(`${MINIMAL}{{task.\nid}}\n`).message, /not a variable/);
  });

  it("reads a file that starts with a byte-order mark", () => {
    parseAgent(`\uFEFF${MINIMAL}`, { source: "a/AGENT.md" });
  });

  it("rejects unknown frontmatter keys", () => {
    assert.match(errorOf(MINIMAL.replace("---\n", "---\nmodle: opus\n")).message, /modle/);
  });

  it("rejects a file with no frontmatter", () => {
    assert.match(errorOf("# Just a body\n").message, /frontmatter/);
  });

  it("rejects frontmatter that is not valid YAML", () => {
    assert.match(errorOf("---\nmodel: [oops\n---\nbody\n").message, /not valid YAML/);
  });

  it("reports every problem at once", () => {
    const e = errorOf(`---\nmax_tokens: 0\noutput:\n  verdicts: []\n---\n{{nope.x}}\n`);
    assert.ok(e.issues.length >= 3, e.message);
  });

  it("rejects non-positive limits and an empty body", () => {
    assert.match(
      errorOf(MINIMAL.replace("---\nDo", "max_tokens: 0\n---\nDo")).message,
      /max_tokens/,
    );
    assert.match(errorOf("---\noutput: {verdicts: [PASS]}\n---\n  \n").message, /body/);
  });
});
