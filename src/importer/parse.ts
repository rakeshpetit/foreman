export interface ParsedTask {
  ref: string;
  title: string;
  kind: string;
  size_est: string;
  depends: string[];
  dependsLine: number;
  line: number;
  do: string;
  doneWhen: string;
  body: string;
}
export interface ParsedMilestone {
  key: string;
  title: string;
  tasks: ParsedTask[];
}
export interface ParsedPlan {
  milestones: ParsedMilestone[];
}

export class ImportError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

const MILESTONE = /^## (M\d+) · (.+?)\s*$/;
const TASK = /^### (M\d+-T\d+) · (.+?)\s*$/;
const KIND = /^- \*\*Kind:\*\* (\S+)/;
const SIZE = /\*\*Size:\*\* (\S+)/;
const DEPENDS = /\*\*Depends:\*\* (.+?)\s*$/;
const DO = /^- \*\*Do(?: \([^)]*\))?:\*\*\s*(.*)$/;
const DONE_WHEN = /^- \*\*Done when:\*\*\s*(.*)$/;
const FIELD = /^- \*\*|^---\s*$/;

export function parseTasks(text: string): ParsedPlan {
  const lines = text.split("\n");
  const milestones: ParsedMilestone[] = [];
  const refs = new Map<string, number>();
  const keys = new Map<string, number>();
  let field: "do" | "doneWhen" | undefined;
  let ms: ParsedMilestone | undefined;
  let task: ParsedTask | undefined;
  let buf: string[] = [];

  const closeTask = () => {
    if (task) task.body = `${buf.join("\n").trim()}\n`;
    task = undefined;
    field = undefined;
    buf = [];
  };

  lines.forEach((raw, i) => {
    const n = i + 1;
    const m = MILESTONE.exec(raw);
    if (m) {
      closeTask();
      const key = m[1] as string;
      const prevMs = keys.get(key);
      if (prevMs !== undefined) {
        throw new ImportError(`duplicate milestone ID ${key} (first defined on line ${prevMs})`, n);
      }
      keys.set(key, n);
      ms = {
        key,
        title: (m[2] as string).replace(/\s*·.*$/, "").trim(),
        tasks: [],
      };
      milestones.push(ms);
      return;
    }
    const t = TASK.exec(raw);
    if (t) {
      closeTask();
      const ref = t[1] as string;
      if (!ms) throw new ImportError(`task ${ref} appears before any milestone`, n);
      if (!ref.startsWith(`${ms.key}-`)) {
        throw new ImportError(`task ${ref} is under milestone ${ms.key}`, n);
      }
      const prev = refs.get(ref);
      if (prev !== undefined) {
        throw new ImportError(`duplicate task ID ${ref} (first defined on line ${prev})`, n);
      }
      refs.set(ref, n);
      task = {
        ref,
        title: t[2] as string,
        kind: "",
        size_est: "",
        depends: [],
        dependsLine: n,
        line: n,
        do: "",
        doneWhen: "",
        body: "",
      };
      ms.tasks.push(task);
      buf.push(raw);
      return;
    }
    if (task) {
      buf.push(raw);
      const section = DO.exec(raw) ?? DONE_WHEN.exec(raw);
      if (section) {
        field = DO.test(raw) ? "do" : "doneWhen";
        task[field] = section[1] as string;
      } else if (FIELD.test(raw)) {
        field = undefined;
      } else if (field) {
        task[field] += `\n${raw}`;
      }
      const k = KIND.exec(raw);
      if (k) {
        task.kind = k[1] as string;
        task.size_est = SIZE.exec(raw)?.[1] ?? "";
        const d = DEPENDS.exec(raw)?.[1];
        task.dependsLine = n;
        if (d && d.toLowerCase() !== "none") {
          task.depends = d
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }
    }
  });
  closeTask();

  for (const m of milestones) {
    for (const t of m.tasks) {
      if (!t.kind) throw new ImportError(`task ${t.ref} has no Kind/Size/Depends line`, t.line);
      if (!t.do.trim()) throw new ImportError(`task ${t.ref} has no Do`, t.line);
      if (!t.doneWhen.trim()) throw new ImportError(`task ${t.ref} has no Done when`, t.line);
      for (const d of t.depends) {
        if (!refs.has(d))
          throw new ImportError(`task ${t.ref} depends on unknown task ${d}`, t.dependsLine);
      }
    }
  }
  if (milestones.length === 0) throw new ImportError("no milestones found", 1);
  return { milestones };
}

export function planTitle(planMd: string): string {
  const h = /^# (.+)$/m.exec(planMd)?.[1];
  return h?.trim() ?? "Untitled request";
}
