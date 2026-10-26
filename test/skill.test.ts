import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveSkills, SkillError, skillRoots } from "../src/config/skill.ts";
import { removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);

function addSkill(
  root: string,
  name: string,
  text = `---\nname: ${name}\n---\nBody of ${name}.\n`,
) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), text);
  return join(root, name);
}

/** Three empty search roots, in precedence order: Target repo, foreman, user. */
function roots() {
  const base = tmpDir("foreman-skills-");
  return { repo: join(base, "repo"), foreman: join(base, "foreman"), user: join(base, "user") };
}

function errorOf(...args: Parameters<typeof resolveSkills>): SkillError {
  try {
    resolveSkills(...args);
  } catch (e) {
    assert.ok(e instanceof SkillError, `expected a SkillError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected a SkillError");
}

describe("resolveSkills", () => {
  it("returns each Skill's folder, and the body of a preloaded Skill only", () => {
    const r = roots();
    const tdd = addSkill(r.foreman, "tdd");
    const diagnose = addSkill(r.foreman, "diagnose");
    const got = resolveSkills(
      { preload: ["tdd"], available: ["diagnose"] },
      { roots: [r.repo, r.foreman, r.user] },
    );
    assert.deepEqual(got.preload, [{ name: "tdd", dir: tdd, body: "Body of tdd.\n" }]);
    assert.deepEqual(got.available, [{ name: "diagnose", dir: diagnose }]);
  });

  it("prefers the Target repo, then foreman, then the user's skills", () => {
    const r = roots();
    const order = [r.repo, r.foreman, r.user];
    addSkill(r.user, "tdd", "user");
    addSkill(r.user, "only-user");
    addSkill(r.foreman, "tdd", "foreman");
    addSkill(r.foreman, "only-foreman");
    addSkill(r.repo, "tdd", "repo");
    const got = resolveSkills(
      { preload: ["tdd", "only-foreman"], available: ["only-user"] },
      { roots: order },
    );
    assert.deepEqual(
      got.preload.map((s) => s.dir),
      [join(r.repo, "tdd"), join(r.foreman, "only-foreman")],
    );
    assert.equal(got.preload[0]?.body, "repo");
    assert.equal(got.available[0]?.dir, join(r.user, "only-user"));
  });

  it("skips a folder with no SKILL.md and falls through to the next root", () => {
    const r = roots();
    mkdirSync(join(r.repo, "tdd"), { recursive: true });
    const real = addSkill(r.foreman, "tdd");
    const got = resolveSkills({ preload: ["tdd"], available: [] }, { roots: [r.repo, r.foreman] });
    assert.equal(got.preload[0]?.dir, real);
  });

  it("follows a symlinked Skill folder, as in ~/.claude/skills", () => {
    const r = roots();
    const elsewhere = tmpDir("foreman-linked-");
    addSkill(elsewhere, "tdd", "---\nname: tdd\n---\nLinked.\n");
    mkdirSync(r.user, { recursive: true });
    symlinkSync(join(elsewhere, "tdd"), join(r.user, "tdd"));
    const got = resolveSkills({ preload: ["tdd"], available: [] }, { roots: [r.user] });
    assert.deepEqual(got.preload, [{ name: "tdd", dir: join(r.user, "tdd"), body: "Linked.\n" }]);
  });

  it("does not resolve a dangling symlink", () => {
    const r = roots();
    mkdirSync(r.user, { recursive: true });
    symlinkSync(join(r.user, "gone"), join(r.user, "tdd"));
    assert.throws(
      () => resolveSkills({ preload: ["tdd"], available: [] }, { roots: [r.user] }),
      SkillError,
    );
  });

  it("keeps a body with no frontmatter whole", () => {
    const r = roots();
    addSkill(r.repo, "plain", "# Plain\nJust text.\n");
    const got = resolveSkills({ preload: ["plain"], available: [] }, { roots: [r.repo] });
    assert.equal(got.preload[0]?.body, "# Plain\nJust text.\n");
  });

  it("resolves nothing for an Agent with no Skills", () => {
    assert.deepEqual(resolveSkills({ preload: [], available: [] }, { roots: [] }), {
      preload: [],
      available: [],
    });
  });

  it("makes a missing Skill a config error listing every path searched", () => {
    const r = roots();
    const order = [r.repo, r.foreman, r.user];
    const e = errorOf(
      { preload: ["nope"], available: [] },
      { roots: order, source: "agents/impl/AGENT.md" },
    );
    assert.match(e.message, /^agents\/impl\/AGENT\.md: skill "nope" not found/);
    for (const root of order)
      assert.ok(e.message.includes(join(root, "nope", "SKILL.md")), e.message);
  });

  it("leaves the message unprefixed when no source is given", () => {
    const e = errorOf({ preload: ["nope"], available: [] }, { roots: [] });
    assert.match(e.message, /^skill "nope" not found/);
  });

  it("reports every missing Skill at once, in both lists", () => {
    const r = roots();
    const e = errorOf({ preload: ["a"], available: ["b"] }, { roots: [r.repo] });
    assert.equal(e.issues.length, 2);
  });

  it("rejects a Skill name that is not a single folder name", () => {
    const r = roots();
    addSkill(r.user, "tdd"); // "../tdd" from the root below would escape to this one
    for (const bad of ["../tdd", "a/b", "", "."]) {
      assert.match(
        errorOf({ preload: [bad], available: [] }, { roots: [join(r.user, "x")] }).message,
        /not a folder name/,
        bad,
      );
    }
  });
});

describe("skillRoots", () => {
  it("lists the Target repo, foreman, then the user's Claude skills", () => {
    const got = skillRoots({ targetRepo: "/t", foremanDir: "/f", home: "/h" });
    assert.deepEqual(got, ["/t/.foreman/skills", "/f/skills", "/h/.claude/skills"]);
  });
});
