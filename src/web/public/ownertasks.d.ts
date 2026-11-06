// Types for ownertasks.js, which is plain JavaScript because the browser loads it as is.

export interface OwnerTaskSource { kind: "next" | "question" | "handoff" | "pm" | "owner" | "guard"; agent?: string; report?: string; at: string }
export interface OwnerTaskView {
  id: string;
  project: string;
  title: string;
  detail?: string;
  sources?: OwnerTaskSource[];
  urgent?: boolean;
  helper?: string;
  status?: "open" | "done" | "dropped";
  createdAt?: string;
  updatedAt?: string;
}

export const TASKS_PATH: string;
export function taskPath(id: string, action: "done" | "drop" | "chat" | "helper" | "reopen" | "merge"): string;
export function cleanTasks(list: unknown): OwnerTaskView[];
export function forProject(tasks: OwnerTaskView[], project: string): OwnerTaskView[];
export function counts(tasks: OwnerTaskView[]): { open: number; urgent: number };
export function grouped(tasks: OwnerTaskView[], names?: Map<string, string>): Array<{ project: string; name: string; tasks: OwnerTaskView[] }>;
export function lastSource(task: OwnerTaskView | null | undefined): OwnerTaskSource | null;
export function withTask(tasks: OwnerTaskView[], task: OwnerTaskView | null | undefined, order?: TaskOrder): OwnerTaskView[];
export type TaskOrder = "newest" | "oldest" | "project";
export const TASK_ORDERS: TaskOrder[];
export const ORDER_KEY: string;
export function readOrder(raw: unknown): TaskOrder;
export function tasksPath(order: TaskOrder): string;
export function sortTasks(tasks: OwnerTaskView[], order?: TaskOrder): OwnerTaskView[];
export function orderGroups(tasks: OwnerTaskView[]): Array<{ key: string; urgent?: true; project?: string; tasks: OwnerTaskView[] }>;

export function tasksRoute(hash: string | null | undefined): { task: string | null; project: string | null } | null;
export function tasksHash(at?: { task?: string | null; project?: string | null }): string;
export function filtered(tasks: OwnerTaskView[], project: string | null): OwnerTaskView[];
export function firstOnes(tasks: OwnerTaskView[], n?: number): OwnerTaskView[];
export function helperStatus(task: (OwnerTaskView & { helperNow?: { id: string; name: string; why?: string }; helperState?: { state: string; since?: string } }) | null | undefined): { state: "working" | "waiting"; name: string; since: string | null } | null;
export const IMAGE_TYPES: string[];
export const FILE_MAX: number;
export function fileProblem(file: { size?: unknown; type?: string } | null | undefined): "type" | "size" | "empty" | null;
export function safeName(name: unknown, type?: string): string;
export function uploadPath(id: string, name: string): string;
export function fileUrl(project: string, fileId: string): string;
export interface TaskFile { id: string; name: string; type?: string; size?: number }
export function filesOf(entry: { files?: unknown } | null | undefined): TaskFile[];
export function isImage(file: { type?: string } | null | undefined): boolean;
export function sizeText(bytes: unknown): string;
export function atBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number } | null | undefined, slack?: number): boolean;

export function closedTasks(list: unknown): Array<OwnerTaskView & { closedAt?: string; mergedInto?: string }>;
export function similarTasks(task: (OwnerTaskView & { similar?: string[] }) | null | undefined, open: OwnerTaskView[]): OwnerTaskView[];
export function mergeTargets(task: OwnerTaskView & { similar?: string[] }, open: OwnerTaskView[]): { similar: OwnerTaskView[]; others: OwnerTaskView[] };

export const CHAT_TEXT_MAX: number;
export const TASK_TEXT_MAX: number;
export function textLength(length: number): "file" | "max" | null;
