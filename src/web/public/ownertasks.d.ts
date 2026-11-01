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
export function taskPath(id: string, action: "done" | "drop" | "chat"): string;
export function cleanTasks(list: unknown): OwnerTaskView[];
export function forProject(tasks: OwnerTaskView[], project: string): OwnerTaskView[];
export function counts(tasks: OwnerTaskView[]): { open: number; urgent: number };
export function grouped(tasks: OwnerTaskView[], names?: Map<string, string>): Array<{ project: string; name: string; tasks: OwnerTaskView[] }>;
export function lastSource(task: OwnerTaskView | null | undefined): OwnerTaskSource | null;
export function withTask(tasks: OwnerTaskView[], task: OwnerTaskView | null | undefined): OwnerTaskView[];
