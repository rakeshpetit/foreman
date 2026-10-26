/**
 * A Stage that needs the Owner: thrown by an executor, and `tick` parks the Task. It carries no
 * Round (CONTEXT: Escalation). Until the Handoff and the `escalations` table arrive in M5-T06, an
 * Escalation is a `parked` Task and a `task.escalated` event.
 */
export class Escalation extends Error {}
