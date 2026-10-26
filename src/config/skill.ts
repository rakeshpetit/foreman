import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Agent, splitFrontmatter } from "./agent.ts";
import { ConfigFileError, stripBom } from "./issues.ts";

/** foreman's own checkout, where its `skills/` folder lives. */
export const FOREMAN_DIR = join(import.meta.dirname, "..", "..");

export interface SkillRootsInput {
  targetRepo: string;
  foremanDir?: string;
  home?: string;
}

/** Where Skills are looked for, most specific first: Target repo, foreman, then the user's own. */
export function skillRoots({
  targetRepo,
  foremanDir = FOREMAN_DIR,
  home = homedir(),
}: SkillRootsInput): string[] {
  return [
    join(targetRepo, ".foreman", "skills"),
    join(foremanDir, "skills"),
    join(home, ".claude", "skills"),
  ];
}

export interface ResolvedSkill {
  name: string;
  /** The Skill's folder, copied unchanged into the container's `.claude/skills/`. */
  dir: string;
}

export interface PreloadedSkill extends ResolvedSkill {
  /** SKILL.md without its frontmatter, to inline into the prompt. */
  body: string;
}

export interface ResolvedSkills {
  preload: PreloadedSkill[];
  available: ResolvedSkill[];
}

export interface SkillOptions {
  /** Search order: the first root holding `<name>/SKILL.md` wins. See {@link skillRoots}. */
  roots: string[];
  /** Named in error messages, e.g. the Agent's AGENT.md. */
  source?: string;
}

/** Every Skill that could not be found, one readable line each (`issues`), prefixed by its source. */
export class SkillError extends ConfigFileError {}

/**
 * Finds the folder of each Skill an Agent names, and the body of each preloaded one. Throws a
 * `SkillError` listing every Skill that is missing and the paths searched for it.
 */
export function resolveSkills(
  skills: Agent["skills"],
  { roots, source }: SkillOptions,
): ResolvedSkills {
  const issues: string[] = [];
  const resolveOne = (name: string): ResolvedSkill | undefined => {
    if (name === "" || name === "." || name === ".." || /[\\/]/.test(name)) {
      issues.push(`skill "${name}" is not a folder name, write a name such as "tdd"`);
      return undefined;
    }
    const candidates = roots.map((root) => join(root, name));
    const dir = candidates.find((d) => isFile(join(d, "SKILL.md")));
    if (!dir) {
      const searched = candidates.map((d) => join(d, "SKILL.md")).join(", ");
      issues.push(`skill "${name}" not found, searched: ${searched}`);
      return undefined;
    }
    return { name, dir };
  };

  const preload: PreloadedSkill[] = [];
  for (const name of skills.preload) {
    const found = resolveOne(name);
    if (!found) continue;
    try {
      preload.push({ ...found, body: skillBody(join(found.dir, "SKILL.md")) });
    } catch (e) {
      issues.push(
        `skill "${name}" could not be read: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const available = skills.available.flatMap((name) => resolveOne(name) ?? []);

  if (issues.length > 0) throw new SkillError(issues, source);
  return { preload, available };
}

/** `statSync` follows symlinks, so a linked Skill folder counts and a dangling link does not. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function skillBody(path: string): string {
  const text = stripBom(readFileSync(path, "utf8"));
  return splitFrontmatter(text)?.body ?? text;
}
