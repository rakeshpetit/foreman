/**
 * The subscription's usage limit is reached: thrown by an executor, and `tick` pauses the queue until
 * `resetsAt` and puts the Task back. It carries no Round and is not retried: nothing can run before
 * the reset.
 */
export class UsageLimit extends Error {
  readonly resetsAt: Date;

  constructor(message: string, resetsAt: Date) {
    super(message);
    this.resetsAt = resetsAt;
  }
}
