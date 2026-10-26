/** The lanes a Task can take through the Pipeline. The one list: the store, `route` and `pipeline.toml` all use it. */
export const LANES = ["normal", "fast"] as const;
export type Lane = (typeof LANES)[number];
