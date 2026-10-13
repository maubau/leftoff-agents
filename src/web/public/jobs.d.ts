// Types for jobs.js, which is plain JavaScript because the browser loads it as is.

export interface JobStep { id: string; status: "pending" | "running" | "done" | "failed"; retryable?: boolean; error?: { type?: string; message?: string; detail?: string } }
export interface Job { id: string; name?: string; projectId?: string; status: "running" | "failed" | "done"; steps?: JobStep[]; origin?: string; startedAt?: string }

export const LEFT_KEY: string;
export const LEFT_KEEP: number;
export function readLeft(raw: unknown): Set<string>;
export function writeLeft(left: Iterable<string>): string;
export function leave(left: Set<string>, job: Pick<Job, "id">): Set<string>;
export function failedStep(job: Job | null | undefined): JobStep | null;
export function canRetry(job: Job | null | undefined): boolean;
export function retryPath(job: Pick<Job, "id">): string;
export function cardsToShow(jobs: Iterable<Job>, options?: { mine?: string | null; left?: Set<string> }): Job[];
export function listOutcome(error: { status?: number } | null | undefined): "loaded" | "unsupported" | "retry";
