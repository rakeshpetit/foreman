import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./schema.ts";

export type Mode = "manual" | "auto";
export type RequestPhase = "planning" | "building" | "done";
export type TaskStatus = "queued" | "active" | "awaiting_owner" | "parked" | "done" | "dropped";

export interface RequestRow {
  id: string;
  title: string;
  target_repo: string;
  mode: Mode;
  status: string;
  phase: RequestPhase;
  token_budget: number | null;
  created_at: string;
}
export interface MilestoneRow {
  id: string;
  request_id: string;
  seq: number;
  title: string;
  branch: string | null;
  status: string;
  created_at: string;
}
export interface TaskRow {
  id: string;
  milestone_id: string;
  seq: number;
  ref: string | null;
  title: string;
  kind: string;
  origin: string;
  parent_task_id: string | null;
  size_est: string | null;
  lane: string;
  stage: string | null;
  stage_state: string | null;
  round_stage: number;
  round_total: number;
  status: TaskStatus;
  agent_overrides: string | null;
  branch: string | null;
  file_path: string | null;
}
export interface RunRow {
  id: number;
  task_id: string;
  request_id: string;
  stage: string;
  agent: string | null;
  model: string | null;
  effort: string | null;
  started_at: string;
  ended_at: string | null;
  verdict: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  context_peak: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  exit_code: number | null;
  report_path: string | null;
  error: string | null;
}
export interface ApprovalRow {
  id: string;
  kind: string;
  subject_id: string;
  status: "pending" | "approved" | "rejected";
  notes: string | null;
  channel: string | null;
  requested_at: string;
  decided_at: string | null;
}
export interface EventRow {
  id: number;
  at: string;
  type: string;
  subject: string | null;
  payload: string | null;
}
export interface QueueState {
  paused_until: string | null;
  reason: string | null;
}

export function foremanHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.FOREMAN_HOME ?? join(homedir(), ".foreman");
}

const PREFIX = { request: "R", milestone: "M", task: "T", approval: "A" } as const;
type IdKind = keyof typeof PREFIX;

export class Store {
  readonly db: DatabaseSync;
  now: () => Date = () => new Date();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  static open(home: string = foremanHome()): Store {
    mkdirSync(home, { recursive: true });
    return new Store(join(home, "foreman.db"));
  }

  static memory(): Store {
    return new Store(":memory:");
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private nextId(kind: IdKind): string {
    this.db
      .prepare(
        "INSERT INTO counters (kind, n) VALUES (?, 1) ON CONFLICT(kind) DO UPDATE SET n = n + 1",
      )
      .run(kind);
    const { n } = this.db.prepare("SELECT n FROM counters WHERE kind = ?").get(kind) as {
      n: number;
    };
    return `${PREFIX[kind]}-${n}`;
  }

  // requests
  createRequest(input: {
    title: string;
    target_repo: string;
    mode?: Mode;
    token_budget?: number;
  }): RequestRow {
    const id = this.nextId("request");
    this.db
      .prepare(
        "INSERT INTO requests (id, title, target_repo, mode, token_budget, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        input.title,
        input.target_repo,
        input.mode ?? "manual",
        input.token_budget ?? null,
        this.iso(),
      );
    return this.getRequest(id) as RequestRow;
  }
  getRequest(id: string): RequestRow | undefined {
    return this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;
  }
  listRequests(): RequestRow[] {
    return this.db
      .prepare("SELECT * FROM requests ORDER BY rowid")
      .all() as unknown as RequestRow[];
  }
  updateRequest(
    id: string,
    patch: Partial<Pick<RequestRow, "mode" | "status" | "phase" | "token_budget">>,
  ): void {
    this.patch("requests", id, patch);
  }

  // milestones
  createMilestone(input: {
    request_id: string;
    seq: number;
    title: string;
    branch?: string;
  }): MilestoneRow {
    const id = this.nextId("milestone");
    this.db
      .prepare(
        "INSERT INTO milestones (id, request_id, seq, title, branch, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, input.request_id, input.seq, input.title, input.branch ?? null, this.iso());
    return this.getMilestone(id) as MilestoneRow;
  }
  getMilestone(id: string): MilestoneRow | undefined {
    return this.db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as
      | MilestoneRow
      | undefined;
  }
  listMilestones(requestId?: string): MilestoneRow[] {
    const sql = requestId
      ? "SELECT * FROM milestones WHERE request_id = ? ORDER BY seq"
      : "SELECT * FROM milestones ORDER BY rowid";
    const stmt = this.db.prepare(sql);
    return (requestId ? stmt.all(requestId) : stmt.all()) as unknown as MilestoneRow[];
  }
  updateMilestone(id: string, patch: Partial<Pick<MilestoneRow, "status" | "branch">>): void {
    this.patch("milestones", id, patch);
  }

  // tasks
  createTask(input: {
    milestone_id: string;
    seq: number;
    title: string;
    ref?: string;
    kind?: string;
    origin?: string;
    parent_task_id?: string;
    size_est?: string;
    lane?: string;
    file_path?: string;
    stage?: string;
  }): TaskRow {
    const id = this.nextId("task");
    this.db
      .prepare(
        `INSERT INTO tasks (id, milestone_id, seq, ref, title, kind, origin, parent_task_id, size_est, lane, file_path, stage)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.milestone_id,
        input.seq,
        input.ref ?? null,
        input.title,
        input.kind ?? "default",
        input.origin ?? "planned",
        input.parent_task_id ?? null,
        input.size_est ?? null,
        input.lane ?? "normal",
        input.file_path ?? null,
        input.stage ?? null,
      );
    return this.getTask(id) as TaskRow;
  }
  getTask(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }
  listTasks(milestoneId?: string): TaskRow[] {
    const sql = milestoneId
      ? "SELECT * FROM tasks WHERE milestone_id = ? ORDER BY seq"
      : "SELECT * FROM tasks ORDER BY rowid";
    const stmt = this.db.prepare(sql);
    return (milestoneId ? stmt.all(milestoneId) : stmt.all()) as unknown as TaskRow[];
  }
  updateTask(
    id: string,
    patch: Partial<
      Pick<
        TaskRow,
        | "stage"
        | "stage_state"
        | "round_stage"
        | "round_total"
        | "status"
        | "branch"
        | "agent_overrides"
        | "title"
      >
    >,
  ): void {
    this.patch("tasks", id, patch);
  }
  addDependency(taskId: string, dependsOn: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?,?)")
      .run(taskId, dependsOn);
  }
  dependenciesOf(taskId: string): string[] {
    return (
      this.db
        .prepare("SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on")
        .all(taskId) as { depends_on: string }[]
    ).map((r) => r.depends_on);
  }

  // runs
  createRun(input: { task_id: string; request_id: string; stage: string; agent?: string }): number {
    const r = this.db
      .prepare(
        "INSERT INTO runs (task_id, request_id, stage, agent, started_at) VALUES (?,?,?,?,?)",
      )
      .run(input.task_id, input.request_id, input.stage, input.agent ?? null, this.iso());
    return Number(r.lastInsertRowid);
  }
  finishRun(
    id: number,
    patch: Partial<Omit<RunRow, "id" | "task_id" | "request_id" | "stage" | "started_at">>,
  ): void {
    this.patch("runs", id, { ended_at: this.iso(), ...patch });
  }
  getRun(id: number): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  }
  listRuns(taskId?: string): RunRow[] {
    const stmt = this.db.prepare(
      taskId
        ? "SELECT * FROM runs WHERE task_id = ? ORDER BY id"
        : "SELECT * FROM runs ORDER BY id",
    );
    return (taskId ? stmt.all(taskId) : stmt.all()) as unknown as RunRow[];
  }

  // approvals
  createApproval(input: { kind: string; subject_id: string; channel?: string }): ApprovalRow {
    const id = this.nextId("approval");
    this.db
      .prepare(
        "INSERT INTO approvals (id, kind, subject_id, channel, requested_at) VALUES (?,?,?,?,?)",
      )
      .run(id, input.kind, input.subject_id, input.channel ?? null, this.iso());
    return this.getApproval(id) as ApprovalRow;
  }
  getApproval(id: string): ApprovalRow | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;
  }
  listApprovals(status?: ApprovalRow["status"]): ApprovalRow[] {
    const stmt = this.db.prepare(
      status
        ? "SELECT * FROM approvals WHERE status = ? ORDER BY rowid"
        : "SELECT * FROM approvals ORDER BY rowid",
    );
    return (status ? stmt.all(status) : stmt.all()) as unknown as ApprovalRow[];
  }
  decideApproval(
    id: string,
    status: "approved" | "rejected",
    notes?: string,
    channel?: string,
  ): void {
    this.db
      .prepare(
        "UPDATE approvals SET status = ?, notes = ?, channel = COALESCE(?, channel), decided_at = ? WHERE id = ?",
      )
      .run(status, notes ?? null, channel ?? null, this.iso(), id);
  }

  // leases
  takeLease(taskId: string, holder: string, ttlMs: number): boolean {
    const now = this.iso();
    const r = this.db
      .prepare(
        `INSERT INTO leases (task_id, holder, expires_at) VALUES (?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
         WHERE leases.expires_at <= ?`,
      )
      .run(taskId, holder, new Date(this.now().getTime() + ttlMs).toISOString(), now);
    return Number(r.changes) > 0;
  }
  releaseLease(taskId: string): void {
    this.db.prepare("DELETE FROM leases WHERE task_id = ?").run(taskId);
  }
  expiredLeases(): string[] {
    return (
      this.db.prepare("SELECT task_id FROM leases WHERE expires_at <= ?").all(this.iso()) as {
        task_id: string;
      }[]
    ).map((r) => r.task_id);
  }

  // queue state
  queueState(): QueueState {
    return this.db
      .prepare("SELECT paused_until, reason FROM queue_state WHERE id = 1")
      .get() as unknown as QueueState;
  }
  setQueueState(state: QueueState): void {
    this.db
      .prepare("UPDATE queue_state SET paused_until = ?, reason = ? WHERE id = 1")
      .run(state.paused_until, state.reason);
  }

  // events
  addEvent(type: string, subject?: string, payload?: unknown): void {
    this.db
      .prepare("INSERT INTO events (at, type, subject, payload) VALUES (?,?,?,?)")
      .run(
        this.iso(),
        type,
        subject ?? null,
        payload === undefined ? null : JSON.stringify(payload),
      );
  }
  listEvents(limit?: number): EventRow[] {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY id").all() as unknown as EventRow[];
    return limit ? rows.slice(-limit) : rows;
  }

  private patch(table: string, id: string | number, patch: Record<string, unknown>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(", ");
    this.db
      .prepare(`UPDATE ${table} SET ${set} WHERE id = ?`)
      .run(...(keys.map((k) => patch[k] ?? null) as (string | number | null)[]), id);
  }
}
