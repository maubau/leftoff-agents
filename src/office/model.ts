import { findPaseoAgent, listPaseoAgents, type ExecFn } from "../agents/delivery.ts";
import { roleFace } from "../core/agents.ts";
import type { Project } from "../core/project.ts";
import { buildSnapshot } from "../core/snapshot.ts";
import type { HubState } from "../hub/state.ts";
import { buildBoard } from "../web/board.ts";
import { officeModel, type OfficeInput, type OfficeModel } from "../web/public/office.js";

/** The office of one project, from the same facts the panel shows: reports, Paseo, the hub's own state. */
export async function projectOffice(project: Project, state: HubState, exec?: ExecFn, now = new Date()): Promise<OfficeModel> {
  const snapshot = await buildSnapshot(project, 14);
  const live = await listPaseoAgents(exec).catch(() => []);
  const board = buildBoard(snapshot, now);
  const agents: NonNullable<OfficeInput["agents"]> = snapshot.agents
    .filter((a) => !a.retired)
    .map((a) => {
      const declared = project.config.agents.find((d) => d.id === a.id);
      const paseo = declared?.paseoAgent ? findPaseoAgent(live, declared.paseoAgent) : undefined;
      return {
        id: a.id,
        face: roleFace(declared?.role) ?? null,
        live: !paseo ? "unknown" : paseo.status === "running" ? "running" : paseo.status === "closed" ? "closed" : "idle",
        status: a.last?.status ?? "none",
        awaiting: state.awaiting[`${project.id}:${a.id}`] !== undefined,
      };
    });
  return officeModel({
    agents,
    handoffs: state.handoffs.filter((h) => h.projectId === project.id),
    counts: { todo: board.todo.length, doing: board.doing.length, blocked: board.blocked.length, done: board.doneTotal },
  });
}
