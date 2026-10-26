/**
 * Every problem with a config file (or a set of them), one readable line each in `issues`. The
 * message is those lines, each prefixed by `source` when there is one. `main.ts` catches this class.
 */
export class ConfigFileError extends Error {
  readonly issues: string[];

  constructor(issues: string[], source?: string) {
    super(issues.map((i) => (source ? `${source}: ${i}` : i)).join("\n"));
    this.name = new.target.name;
    this.issues = issues;
  }
}

/** A zod issue path as `a.b[0].c`, or `fallback` when the issue is about the whole value. */
export function formatPath(path: PropertyKey[], fallback: string): string {
  let out = "";
  for (const part of path) {
    out += typeof part === "number" ? `[${part}]` : out ? `.${String(part)}` : String(part);
  }
  return out || fallback;
}

/** `unknown agent "coder" (known: critic, writer)`: the message for a name that is not one of `known`. */
export function unknownName(what: string, name: string, known: Iterable<string>): string {
  return `unknown ${what} "${name}" (known: ${[...known].sort().join(", ")})`;
}

/** The text without a leading byte order mark. */
export function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}
