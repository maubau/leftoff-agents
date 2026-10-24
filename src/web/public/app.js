// Leftoff control panel. No framework, no build step: the page renders what /api/* says and
// never works out a status itself. Every string that came from a report goes in as text, never as HTML.

import { CODES, LOCALES, STR, strings } from "/i18n.js";
import { RES, officeLayout, officeModel, playScene } from "/office.js";
import { choicesOf, liveChoices, optionReply, threadOf } from "/choices.js";
import { LEFT_KEY, canRetry, cardsToShow, failedStep, leave, listOutcome, readLeft, retryPath, writeLeft } from "/jobs.js";
import { badgeOf, drawHomeBase, drawHomeLive, drawPlot, homeLayout, plotLayout, themeFor } from "/home.js";
import { BLEED, DEPTH, MIN_SCALE, SHIFT, buildingBusy, buildingLayout, drawBuilding } from "/building.js";

const ICON = { blocked: "⛔", needs_input: "❓", progress: "🔄", done: "✅", idle: "💤", quiet: "·", none: "·" };
const WARN_AT = 80;

const S = {
  lang: "it",
  overview: null,
  detail: null,
  route: { page: "overview", id: null },
  feed: [],
  draft: null,
  busy: new Set(),
  chatTab: false,
  tab: "reports",
  openReports: new Set(),
  // The activity register of the open project (D-052): what passed between the PM and the agents, apart from the chat.
  activity: { project: null, entries: [], loaded: false, more: true, unsupported: false, agent: null, type: null, fresh: 0, open: new Set() },
  error: null,
  sending: false,
  // Model settings: the PM's (loaded when its drawer opens) and the agents' of the open project.
  pmSet: null,
  setOpen: false,
  agentSet: null,
  agentSetFor: null,
  setMsg: null,
  // The "new agent" form of the open project, and the agent whose name and role are being edited.
  newAgent: null,
  editing: null,
  // A new project (D-056): what the server offers (undefined: not asked yet, false: it does not offer it) and the form.
  projectOptions: undefined,
  newProject: null,
  // Rooms that have just appeared on the Home (not the ones it opened with): they come in, once.
  seenProjects: null,
  arriving: new Set(),
  // The project being set up (D-056): its page leads to adding agents, one after the other, until "I'm done".
  guided: null,
  guideOpened: new Set(),
  // Creations in progress or stopped, whoever started them (the hub lists the last ones), and the ones left as they are.
  jobs: new Map(),
  jobsLoaded: false,
  jobErrors: new Map(),
  leftJobs: readLeft((() => { try { return localStorage.getItem(LEFT_KEY); } catch { return null; } })()),
  jobsLoading: false,
};
/** The viewer's language: their own choice on this device, else the one the hub speaks. */
const chosenLang = () => { try { return localStorage.getItem("leftoff_lang"); } catch { return null; } };
let cached = { lang: "", dict: null };
const t = () => (cached.lang === S.lang ? cached.dict : (cached = { lang: S.lang, dict: strings(S.lang) }).dict);

/** Tiny DOM builder: strings become text nodes, so nothing a report says can become markup. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    // The page's CSP forbids style attributes; the CSSOM is allowed, so "width:40%" is applied as properties.
    else if (k === "style") for (const decl of String(v).split(";")) { const at = decl.indexOf(":"); if (at > 0) el.style.setProperty(decl.slice(0, at).trim(), decl.slice(at + 1).trim()); }
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== undefined && kid !== null && kid !== false) el.append(kid);
  return el;
}

// ---------- time ----------
function ago(iso) {
  if (!iso) return t().never;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return t().now;
  const m = s / 60, hr = m / 60, d = hr / 24;
  return t().ago(m < 60 ? `${Math.round(m)} min` : hr < 48 ? `${Math.round(hr)} h` : `${Math.round(d)} ${t().days}`);
}
function inTime(ms) {
  const m = Math.max(0, (ms - Date.now()) / 60_000);
  const x = m < 60 ? `${Math.round(m)} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} ${t().days}`;
  return t().inTime(x);
}
const fmt = (iso, opts) => new Date(iso).toLocaleString(LOCALES[S.lang] ?? "en-GB", { timeZone: S.overview?.timezone, ...opts });
const clock = (iso) => fmt(iso, { hour: "2-digit", minute: "2-digit" });
const dayKey = (iso) => fmt(iso, { year: "numeric", month: "2-digit", day: "2-digit" });
function dayLabel(iso) {
  const key = dayKey(iso);
  if (key === dayKey(new Date().toISOString())) return t().today;
  if (key === dayKey(new Date(Date.now() - 86_400_000).toISOString())) return t().yesterday;
  return fmt(iso, { weekday: "short", day: "numeric", month: "short" });
}

// ---------- api ----------
async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    // `type`, `reason`, `existing` and `detail` say what kind of refusal it was, for a message in the owner's language.
    const body = await res.json().catch(() => ({}));
    const { type, reason, existing, detail, step } = body;
    throw Object.assign(new Error(typeof body.error === "string" ? body.error : res.statusText), { status: res.status, type, reason, existing, detail, step });
  }
  return res.json();
}

async function loadOverview() {
  S.overview = await api("/api/overview");
  const mine = chosenLang();
  S.lang = mine && STR[mine] ? mine : STR[S.overview.language] ? S.overview.language : "en";
  document.documentElement.lang = S.lang;
}
async function loadDetail() {
  if (S.route.page !== "project") return void (S.detail = null);
  try {
    S.detail = await api(`/api/projects/${encodeURIComponent(S.route.id)}`);
  } catch (e) {
    if (e.status === 404) location.hash = "#/";
    else throw e;
  }
}
const threadParam = () => (S.route.page === "project" ? S.route.id : null);
/** Only the draft waiting in the open thread, after the PM has answered: is there one still, and which. */
async function reloadDraft() {
  const thread = threadParam();
  try {
    const res = await api(`/api/feed?limit=1${thread ? `&project=${encodeURIComponent(thread)}` : ""}`);
    if (threadParam() === thread) S.draft = res.draft;
  } catch {
    /* the next refresh has it */
  }
  renderChat();
}
async function loadFeed() {
  const thread = threadParam();
  const res = await api(`/api/feed?limit=150${thread ? `&project=${encodeURIComponent(thread)}` : ""}`);
  S.feed = res.entries;
  S.draft = res.draft;
  S.busy = new Set(res.busy);
}

/** The page rebuilt under a swipe cuts its momentum short: a refresh waits until nothing has scrolled for a moment. */
let scrolledAt = 0;
let renderLater = 0;
document.addEventListener("scroll", () => { scrolledAt = Date.now(); }, { capture: true, passive: true });
function renderWhenStill() {
  const idle = Date.now() - scrolledAt;
  if (idle >= 800) return void render();
  clearTimeout(renderLater);
  renderLater = setTimeout(renderWhenStill, 850 - idle);
}

let refreshing = false;
async function refresh(all = true) {
  if (refreshing) return;
  refreshing = true;
  try {
    await loadOverview();
    noteContacts(S.overview.projects);
    await Promise.all([loadDetail(), loadFeed(), S.setOpen ? loadPmSettings() : null]);
    S.error = null;
  } catch (e) {
    S.error = e.status === 401 ? e.message : t().loadErr;
  } finally {
    refreshing = false;
  }
  if (all) renderWhenStill();
  if (S.route.page === "overview" && S.projectOptions === undefined) void loadProjectOptions().then(async (news) => { if (news) { await loadJobs(); render(); } });
  else if (S.route.page === "overview" && S.projectOptions && !S.jobsLoaded) void loadJobs().then((news) => news && render());
  if (S.route.page === "project" && S.agentSetFor !== S.route.id) void loadAgentSettings().then((news) => { if (news && S.detail && maybeGuide(S.detail.project)) return; if (news) render(); });
  else if (S.route.page === "project" && S.detail && S.agentSet) maybeGuide(S.detail.project);
  if (S.route.page === "project" && (S.activity.project !== S.route.id || !S.activity.loaded)) void loadActivity().then((news) => news && render());
}

// ---------- pieces ----------
function status(value) {
  return h("span", { class: `status ${value}` }, h("span", { "aria-hidden": "true", text: ICON[value] ?? "·" }), t().status[value] ?? value);
}
function liveDot(live) {
  return h("span", { class: `dot ${live}`, title: t().live[live] ?? live, role: "img", "aria-label": t().live[live] ?? live });
}

function meter(w) {
  const now = Date.now();
  // Codex's percentage is a reading; once its own reset time has passed the window is empty again,
  // whatever the log last said. Codex has a number; Claude Code never does. (The PM's spend is a plain figure, no cap: it is not a balance.)
  const measured = w.usedPercent !== null && w.valueText === undefined;
  const lapsed = measured && w.resetsAt !== null && w.resetsAt <= now;
  const pct = lapsed ? 0 : w.usedPercent;
  const reached = w.reached && !lapsed;
  const unmeasured = w.usedPercent === null && w.valueText === undefined;
  const cls = reached ? "crit" : pct !== null && pct >= WARN_AT ? "warn" : "";
  const product = w.account ? `${w.product} (${w.account})` : w.product;
  const name = w.label ? `${product} · ${w.label}` : product;

  let value, sub = "", title = "";
  if (w.valueText !== undefined) value = w.valueText;
  else if (reached) value = t().reached;
  else if (lapsed) value = "0%";
  else if (unmeasured) value = t().notAvailable;
  else value = `${Math.round(pct)}%`;

  if (lapsed) sub = t().windowReset;
  else if (unmeasured && !reached) {
    // Not "no limit": Claude Code has one, but reports it only at the moment it is hit.
    sub = w.observedAt ? t().lastLimit(ago(new Date(w.observedAt).toISOString())) : t().neverLimited;
    title = t().noPercent;
  } else if (w.resetsAt) {
    sub = `${t().limitReset} ${inTime(w.resetsAt)}`;
    title = `${t().limitReset}: ${fmt(new Date(w.resetsAt).toISOString(), { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
  }
  return h("div", { class: `meter ${cls}`, title },
    h("div", { class: "row" }, h("span", { text: name }), h("b", { text: value })),
    pct !== null || reached ? h("div", { class: "track" }, h("div", { class: "fill", style: `width:${reached ? 100 : Math.min(100, pct)}%` })) : null,
    sub ? h("div", { class: "small muted", text: sub }) : null);
}

function renderTop() {
  // A language list being chosen from must not be rebuilt under the owner's finger by the 10 s refresh.
  if (document.activeElement?.classList?.contains("lang")) return;
  const o = S.overview;
  const top = document.getElementById("top");
  top.replaceChildren(
    h("a", { class: "brand", href: "#/" },
      h("img", { src: "/favicon.svg", alt: "", width: 22, height: 22 }), "Leftoff"),
    o ? h("span", { class: "pill-live" }, h("span", { class: `dot ${S.error ? "off" : "ok"}` }), S.error ? t().loadErr : [o.channel !== "none" ? o.channel : "", `${t().alertsLabel}: ${t().levels[o.notifyLevel] ?? o.notifyLevel}`, o.quietHours ? t().quiet : ""].filter(Boolean).join(" · ")) : null,
    h("span", { class: "spacer" }),
    h("select", { class: "lang", "aria-label": t().language, title: t().language, onchange: (ev) => { try { localStorage.setItem("leftoff_lang", ev.target.value); } catch { /* private mode */ } S.lang = ev.target.value; document.documentElement.lang = S.lang; render(); } },
      CODES.map((code) => h("option", { value: code, selected: code === S.lang, text: STR[code].name }))),
    o ? h("div", { class: "meters" }, o.limits.map(meter), meter({ product: "PM", label: "", usedPercent: null, resetsAt: null, reached: false, valueText: t().pmSpent(o.pm.spentUsd.toFixed(2)) })) : null);
}

// ---------- the office ----------
/** Which way a project is furnished: each project its own, the same on the Home and on its own page. */
const themeOf = (project) => themeFor(project, S.overview?.projects ?? [project]);

/**
 * A project's room on the Home: its office furnished as its theme says, with its name on the sign and its description
 * on the notice board, written in pixels. The whole card is the link to the project; nothing else is written on it.
 */
function roomCard(p) {
  const model = officeModel(p);
  model.theme = themeOf(p);
  model.off = p.agents.length === 0; // nobody works there: the lights are off
  // A project the hub says is not completely made (D-056) wears the badge of a blocked one, and says why.
  const unfinished = p.creation ? (p.creation.step === "paseo" ? t().newProject.notInPaseo : t().newProject.incomplete) : null;
  const text = { name: p.name, description: p.purpose || (model.off ? t().roomEmpty : ""), badge: unfinished ? "blocked" : badgeOf(p.headline), autonomous: p.mode === "autonomous" };
  const layout = homeLayout(model, text.description);
  const canvas = h("canvas", { class: "home-room", width: layout.width * RES, height: layout.height * RES, "aria-hidden": "true" });
  canvas._home = { model, text, layout, project: p.id };
  paintHome(canvas, performance.now());
  // What a screen reader says, and what a mouse sees on hover: the one name and description, and how the project is.
  const state = [unfinished, t().status[p.headline], p.mode === "autonomous" ? t().set.mode.autonomous : null, p.mutedUntil ? t().muted : null].filter(Boolean).join(", ");
  return h("a", { class: `room-card${S.arriving.has(p.id) ? " arrive" : ""}`, href: `#/p/${encodeURIComponent(p.id)}`, title: [p.name, p.purpose, unfinished].filter(Boolean).join(" — "), "aria-label": [p.name, p.purpose, model.off ? t().roomEmpty : null, state].filter(Boolean).join(". ") }, canvas);
}

/** Redraws a Home room; says whether anything in it is moving, so the loop knows to hurry. */
function paintHome(canvas, time) {
  const home = canvas._home;
  const { model, text, layout, project } = home;
  const ctx = canvas.getContext("2d");
  // What does not move is drawn once, to a canvas of its own, and copied; only the desks and the people are redrawn.
  if (!home.base) {
    home.base = document.createElement("canvas");
    home.base.width = layout.width * RES;
    home.base.height = layout.height * RES;
    drawHomeBase(adapt(home.base.getContext("2d")), model, text, layout);
  }
  const scene = sceneFor(project);
  ctx.clearRect(0, 0, layout.width * RES, layout.height * RES);
  ctx.drawImage(home.base, 0, 0);
  drawHomeLive(adapt(ctx), model, text, time, scene, layout);
  return playScene(model, layout.room, scene, time).busy;
}

/** Whether any of an element is on the screen: what is out of sight is not redrawn. */
function onScreen(el) {
  const box = el.getBoundingClientRect();
  return box.bottom > 0 && box.top < innerHeight;
}

/**
 * The office as a stage of four layers, from the back to the front: the building (sky, skyline, facade), the rooms,
 * the desks and the people. Each is its own canvas, drawn by /building.js and /office.js, and the loop below moves
 * them at different speeds as the page scrolls on a phone, which is what gives it depth (not with the mouse).
 * `projects` are the rooms: all of them on the overview, the one on a project's own page.
 */
function officeStage(projects, { signs = true } = {}) {
  const main = document.getElementById("main");
  // A row of rooms may be as wide as the page can show at a size a phone can still read.
  const avail = Math.max(280, Math.min(main.clientWidth - 64, 1000));
  const building = buildingLayout(projects.map(roomOf), Math.floor(avail / MIN_SCALE));
  const { width: W, height: H } = building;
  const layer = (cls, canvas, ...extra) => h("div", { class: `layer ${cls}` }, canvas, ...extra);
  const canvas = (w = W * RES, hh = H * RES) => h("canvas", { width: w, height: hh });
  const bg = h("canvas", {
    class: "layer l-bg", width: (W + BLEED * 2) * RES, height: (H + BLEED * 2) * RES,
    style: `left:${(-BLEED / W) * 100}%;top:${(-BLEED / H) * 100}%;width:${((W + BLEED * 2) / W) * 100}%;height:${((H + BLEED * 2) / H) * 100}%`,
  });
  const c = { rooms: canvas(), desks: canvas(), people: canvas() };
  const layers = { bg, rooms: layer("l-rooms", c.rooms, signs ? roomSigns(building) : null), desks: layer("l-desks", c.desks, officeCaptions(building)), people: layer("l-people", c.people) };
  const stage = h("div", { class: "stage", role: "img", "aria-label": projects.map((p) => officeLabel(p, officeModel(p))).join(". "), style: `aspect-ratio:${W} / ${H};max-width:${W * 4}px;--w:${W}` },
    layers.bg, layers.rooms, layers.desks, layers.people);
  stage._stage = { building, layers, ctx: { bg: bg.getContext("2d"), rooms: c.rooms.getContext("2d"), desks: c.desks.getContext("2d"), people: c.people.getContext("2d") }, v: { x: 0, y: 0 } };
  // The back two never change until the next refresh: drawn once. The front two are redrawn by the loop.
  drawBuilding(adapt(stage._stage.ctx.bg), building, "bg");
  drawBuilding(adapt(stage._stage.ctx.rooms), building, "rooms");
  paintStage(stage, performance.now());
  return stage;
}

/** One project's room, as the building draws it. */
function roomOf(p) {
  const model = officeModel(p);
  model.captions = true; // room under each desk for the agent's name and role (officeCaptions)
  model.off = p.agents.length === 0; // nobody works there: the lights are off
  model.theme = themeOf(p); // furnished as it is on the Home
  return { id: p.id, name: p.name, model, project: p };
}

const adapt = (ctx) => ({ rect: (x, y, w, hh, colour) => { ctx.fillStyle = colour; ctx.fillRect(x, y, w, hh); } });

/** Each project's name on the wall of its room, a link to the project; a room with the lights off says why. */
function roomSigns(building) {
  const { width, height } = building;
  return h("div", { class: "room-signs", "aria-hidden": "true" }, building.rooms.map((room) =>
    h("a", {
      class: `room-sign${room.model.off ? " off" : ""}`, href: `#/p/${encodeURIComponent(room.id)}`, tabindex: "-1", title: room.name,
      style: `left:${(room.sign.x / width) * 100}%;top:${(room.sign.y / height) * 100}%;width:${(room.sign.w / width) * 100}%;height:${(room.sign.h / height) * 100}%`,
    }, h("b", { text: room.name }), room.model.off ? h("span", { text: t().roomEmpty }) : null)));
}

/** A role cut to a few words: what comes before the first ";" or " - ", and at most `max` characters, ending in an ellipsis. */
function shortRole(role, max = 30) {
  const first = String(role).split(/;| [-–—] /)[0].trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 12)).trimEnd()}…`;
}

/**
 * What an agent does, in a few small words under its desk. Its name is the one on the plate of the desk, in pixels; the
 * role is HTML laid over the canvas (the pixel face of the plate has no room for it), shortened, with the whole role and
 * the agent's full name in a tooltip. No label behind it: an outline keeps it readable on any floor.
 */
function officeCaptions(building) {
  const { width, height } = building;
  return h("div", { class: "office-captions", "aria-hidden": "true" }, building.rooms.flatMap((room) => room.captions.map((c) => {
    const a = room.project.agents.find((x) => x.id === c.id);
    if (!a?.role) return null;
    return h("div", {
      class: "office-caption", title: `${a.name} — ${a.role}`,
      style: `left:${(c.x / width) * 100}%;top:${(c.y / height) * 100}%;width:${(c.w / width) * 100}%;height:${(c.h / height) * 100}%`,
    }, h("span", { class: "cap-role", text: shortRole(a.role) }));
  }).filter(Boolean)));
}

function officeLabel(p, model) {
  return `${t().office} ${p.name}: ` + (model.agents.length ? model.agents.map((a) => `${a.id} ${t().states[a.state]}`).join(", ") : t().roomEmpty);
}

// What is happening in the office right now, between the refreshes: the PM answering the owner, and an
// agent getting up to talk to the PM. These are moments, not state, so they live here and fade on their own.
const PM_PATIENCE = 180_000; // a PM that never answers stops looking busy after this
const live = { pm: new Map(), visits: new Map(), exact: new Map(), agents: null, seen: new Set() };

/** The owner wrote (thread: a project id, or "general"): the PM sits up, at its screen or with its phone if it came from the chat app. */
function pmBegins(thread, mode) {
  live.pm.set(thread, { mode, until: performance.now() + PM_PATIENCE });
}
function pmEnds(thread) {
  const busy = live.pm.get(thread);
  if (busy) busy.until = Math.min(busy.until, performance.now() + 700);
}
function noteFeed(e) {
  if (live.seen.has(e.id)) return;
  if (live.seen.size > 300) live.seen.clear();
  live.seen.add(e.id);
  const thread = e.projectId ?? "general";
  if (e.role === "owner") pmBegins(thread, e.source === "telegram" ? "phone" : "typing");
  else if (e.kind === "reply") pmEnds(thread);
}

/** The PM has just talked to an agent. `exact` is the hub saying so; otherwise it is a guess from the data changing. */
function contact(project, agent, kind, exact) {
  const key = `${project}:${agent}`;
  const now = performance.now();
  if (exact) live.exact.set(key, now);
  else if (now - (live.exact.get(key) ?? -Infinity) < 30_000) return; // already told by the hub
  const visits = live.visits.get(project) ?? [];
  visits.push({ agent, kind, at: now });
  live.visits.set(project, visits);
}

/** Without a hub event, an agent that is newly awaited, or has a new thing in its inbox, was just spoken to. */
function noteContacts(projects) {
  const next = new Map();
  for (const p of projects) for (const a of p.agents) next.set(`${p.id}:${a.id}`, { project: p.id, agent: a.id, awaiting: a.awaiting, inbox: a.pendingInbox });
  if (live.agents) {
    for (const [key, now] of next) {
      const before = live.agents.get(key);
      if (before && ((now.awaiting && !before.awaiting) || now.inbox > before.inbox)) contact(now.project, now.agent, "talk", false);
    }
  }
  live.agents = next;
}

function sceneFor(project) {
  const now = performance.now();
  const pm = [live.pm.get(project), live.pm.get("general")].find((x) => x && x.until > now);
  return { ...(pm ? { pm: pm.mode } : {}), visits: live.visits.get(project) ?? [], reduced: STILL };
}

function prune() {
  const now = performance.now();
  for (const [thread, busy] of live.pm) if (busy.until <= now) live.pm.delete(thread);
  for (const [project, visits] of live.visits) {
    const recent = visits.filter((v) => now - v.at < 120_000);
    recent.length ? live.visits.set(project, recent) : live.visits.delete(project);
  }
}


/** Redraws the two layers that move (desks, people); says whether anything is, so the loop knows to hurry. */
function paintStage(stage, time) {
  const { building, ctx } = stage._stage;
  const scenes = new Map(building.rooms.map((room) => [room.id, sceneFor(room.id)]));
  for (const name of ["desks", "people"]) {
    ctx[name].clearRect(0, 0, building.width * RES, building.height * RES);
    drawBuilding(adapt(ctx[name]), building, name, time, scenes);
  }
  return buildingBusy(building, time, scenes);
}

// Parallax: on a touch screen the layers shift against each other as the page scrolls past. Nothing moves with the
// mouse: a pointer over the picture changes nothing in it, and for anyone who asked for less motion nothing moves at all.
const STILL = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const COARSE = window.matchMedia?.("(pointer: coarse)").matches;

function parallax(stage) {
  if (!COARSE) return;
  const st = stage._stage;
  const box = stage.getBoundingClientRect();
  if (box.bottom < 0 || box.top > innerHeight) return;
  // On a touch screen the thing that moves is the page: how far the stage is from the middle of the screen.
  const target = { x: 0, y: Math.max(-1, Math.min(1, (box.top + box.height / 2 - innerHeight / 2) / innerHeight * 2)) };
  st.v.x += (target.x - st.v.x) * 0.12;
  st.v.y += (target.y - st.v.y) * 0.12;
  const unit = (box.width / st.building.width) * SHIFT; // CSS pixels the nearest layer may move
  for (const [name, depth] of Object.entries(DEPTH)) {
    st.layers[name].style.transform = `translate3d(${(-st.v.x * unit * depth).toFixed(2)}px, ${(-st.v.y * unit * depth).toFixed(2)}px, 0)`;
  }
}

let lastFrame = 0;
let hurry = false;
function animate(now) {
  if (!document.hidden) {
    const stages = [...document.querySelectorAll(".stage")];
    if (!STILL) for (const stage of stages) parallax(stage);
    // Eight frames a second is plenty for a desk; a walk needs more to look like one. Nothing moves when the tab is hidden.
    if (now - lastFrame > (hurry && !STILL ? 30 : 120)) {
      lastFrame = now;
      prune();
      let busy = false;
      for (const stage of stages) busy = paintStage(stage, now) || busy;
      for (const canvas of document.querySelectorAll("canvas.home-room")) if (onScreen(canvas)) busy = paintHome(canvas, now) || busy;
      hurry = busy;
    }
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

function officeSection(p) {
  const name = (id) => p.agents.find((a) => a.id === id)?.name ?? id;
  const model = officeModel(p);
  return h("section", { class: "card office-card" },
    officeStage([p], { signs: false }),
    h("div", { class: "office-legend" },
      model.agents.map((m) => {
        const a = p.agents.find((x) => x.id === m.id);
        return h("div", { class: "who" },
          h("span", { class: "face", text: a.face ?? "🤖" }),
          h("b", { text: a.name }),
          h("span", { class: "small muted", text: a.role ?? t().noRole }),
          h("span", { class: `st ${m.state}`, text: t().states[m.state] }));
      })),
    p.handoffs.length
      ? h("div", { class: "handoffs" }, p.handoffs.map((x) =>
          h("div", { class: "handoff" },
            h("span", { text: "🤝" }), h("b", { text: `${name(x.from)} → ${name(x.to)}` }), h("span", { text: x.ask }),
            h("span", { class: "small muted", text: x.shown ? t().handoffWaiting : t().handoffQueued }))))
      : null);
}

function askCard(a) {
  // A tap says the option to the PM in the project's thread, naming the agent, as Telegram's button does.
  const say = (option) => send(optionReply(a.agentName ?? a.agent[0].toUpperCase() + a.agent.slice(1), option), a.projectId);
  return h("div", { class: `card ask ${a.status}` },
    h("div", { class: "head" }, status(a.status), h("a", { href: `#/p/${encodeURIComponent(a.projectId)}`, text: a.projectName }), h("span", { class: "small muted", text: `${a.agent} · ${ago(a.at)}` })),
    h("div", { class: "text", text: a.text }),
    a.options.length ? h("div", { class: "opts" }, a.options.map((o) => h("button", { class: `chip${o === a.recommend ? " rec" : ""}`, type: "button", title: o === a.recommend ? t().rec : "", onclick: () => say(o), text: o === a.recommend ? `${o} ★` : o }))) : null);
}

function renderOverview() {
  const o = S.overview;
  const ids = o.projects.map((p) => p.id);
  if (S.seenProjects) for (const id of ids) if (!S.seenProjects.has(id)) S.arriving.add(id);
  S.seenProjects = new Set(ids);
  if (S.arriving.size) setTimeout(() => { S.arriving.clear(); for (const el of document.querySelectorAll(".room-card.arrive")) el.classList.remove("arrive"); }, 1200);
  return [
    h("h2", { text: t().needsYou }),
    o.asks.length ? h("div", { class: "asks" }, o.asks.map(askCard)) : h("p", { class: "muted", text: t().nothingNeeded }),
    // «+ New project» next to the title: on a phone the plot at the end of the rooms is screens away.
    h("div", { class: "h2row" }, h("h2", { text: t().projects }),
      S.projectOptions && !S.newProject ? h("button", { id: "np-open", class: "btn primary", type: "button", text: `+ ${t().newProject.tile}`, onclick: () => openNewProject("top") }) : null),
    jobBanners(),
    S.projectOptions && !o.projects.length && !S.newProject ? h("p", { class: "muted", text: t().newProject.empty }) : null,
    S.newProject?.at === "top" ? newProjectSlot() : null,
    h("div", { class: "rooms" }, o.projects.map(roomCard), S.newProject?.at === "top" ? null : newProjectSlot()),
  ];
}

// ---------- model settings ----------
const jsonPost = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/**
 * A list being chosen from, or a field being typed in, must not be rebuilt under the owner's finger by a
 * refresh or a new chat line. Nothing re-renders on blur either: that would replace a button between the
 * press and the release of a click on it. The next refresh (10 s at most) catches up.
 */
const picking = (root) => root.contains(document.activeElement) && document.activeElement.matches("select.set-sel, .form-in");

async function loadPmSettings() {
  try { S.pmSet = await api("/api/settings/pm"); } catch { S.pmSet = null; }
}
/** The open project's agents: asked of Paseo, so once per visit rather than every refresh. True when it has news. */
async function loadAgentSettings() {
  const id = S.route.id;
  if (S.route.page !== "project" || S.agentSetFor === id) return false;
  S.agentSetFor = id;
  S.agentSet = null;
  let agents = null;
  try { agents = (await api(`/api/settings/projects/${encodeURIComponent(id)}/agents`)).agents; } catch { /* an older hub: no settings */ }
  if (S.route.id !== id) return false;
  S.agentSet = agents;
  return agents !== null;
}

/** The hub's refusals are in English; the owner reads them in their language, by what kind of refusal it was. */
function settingError(e) {
  const L = t().set.err;
  return { 400: L.bad, 403: L.cross, 404: L.missing, 409: L.conflict, 502: L.paseo }[e.status] ?? L.other;
}

async function applySetting(key, path, body, done) {
  document.activeElement?.blur?.();
  S.setMsg = { key, kind: "busy" };
  render();
  try {
    done(await jsonPost(path, body));
    S.setMsg = { key, kind: "ok" };
    setTimeout(() => { if (S.setMsg?.key === key && S.setMsg.kind === "ok") { S.setMsg = null; render(); } }, 3000);
  } catch (e) {
    S.setMsg = { key, kind: "err", text: settingError(e), raw: e.message };
  }
  render();
}

function settingMsg(key) {
  const m = S.setMsg;
  if (m?.key !== key) return null;
  const text = m.kind === "busy" ? t().set.saving : m.kind === "ok" ? t().set.saved : m.text;
  // What the hub or Paseo said, word for word, is only a tooltip: the sentence the owner reads is translated.
  return h("span", { class: `small set-msg ${m.kind}`, role: "status", title: m.raw ?? "", text });
}

/**
 * A labelled list of choices; the current value is always among them, even if the hub did not offer it.
 * `name` is what a screen reader says when the visible label alone would be the same on every card.
 */
function picker(label, options, value, onPick, disabled = false, name = label) {
  const shown = options.some(([v]) => v === value) || value == null ? options : [[value, String(value)], ...options];
  return h("label", { class: "set-row" },
    h("span", { text: label }),
    h("select", { class: "set-sel", "aria-label": name, disabled, onchange: (ev) => onPick(ev.target.value) },
      shown.map(([v, text]) => h("option", { value: v, selected: v === value, text }))));
}

const levelName = (id) => t().set.levels[id] ?? id;

function pmSettings() {
  const L = t().set;
  const pm = S.pmSet;
  if (!pm) return h("div", { class: "pmset small muted", text: "…" });
  const save = (body) => applySetting("pm", "/api/settings/pm", body, (r) => (S.pmSet = r));
  return h("div", { class: "pmset" },
    pm.models.length
      ? picker(L.model, pm.models.map((m) => [m.id, m.label]), pm.model, (v) => save({ model: v }))
      : [h("div", { class: "set-row" }, h("span", { text: L.model }), h("b", { text: pm.model })), h("div", { class: "small muted", text: L.pmOther })],
    picker(L.level, pm.efforts.map((e) => [e, levelName(e)]), pm.effort, (v) => save({ effort: v })),
    h("div", { class: "small" }, settingMsg("pm") ?? h("span", { class: "muted", text: L.pmNext })),
    // The operational PM (D-064): one of the Paseo agents, or nobody.
    pm.operational
      ? [
          picker(L.opsPm, [["", L.opsNone], ...pm.operational.candidates.map((c) => [`${c.project}/${c.agent}`, c.name])],
            pm.operational.current ? `${pm.operational.current.project}/${pm.operational.current.agent}` : "",
            (v) => { const [project, agent] = v.split("/"); void save({ operational: v ? { project, agent } : null }); }),
          h("div", { class: "small muted", text: L.opsHint }),
        ]
      : null);
}

/** One agent's model and thinking level, as Paseo reports them. */
function agentSettings(a, project) {
  const s = S.agentSet?.find((x) => x.id === a.id);
  if (!s) return null;
  const L = t().set;
  if (!s.reachable) return h("div", { class: "small muted", text: L.noPaseo });
  const save = (body) => applySetting(a.id, `/api/settings/projects/${encodeURIComponent(project.id)}/agents/${encodeURIComponent(a.id)}`, body, (r) => {
    S.agentSet = S.agentSet.map((x) => (x.id === a.id ? r.agent : x));
  });
  const levels = s.models.find((m) => m.id === s.model)?.thinking ?? [];
  return h("div", { class: "set" },
    s.models.length || s.model
      ? h("label", { class: "set-row", title: s.canSetModel ? "" : L.modelLocked },
          h("span", { text: L.model }),
          h("select", { class: "set-sel", "aria-label": L.agentModel(a.name), disabled: !s.canSetModel, onchange: (ev) => save({ model: ev.target.value }) },
            (s.models.some((m) => m.id === s.model) || !s.model ? s.models : [{ id: s.model, label: s.model }, ...s.models]).map((m) => h("option", { value: m.id, selected: m.id === s.model, text: m.label }))))
      : null,
    s.canSetThinking && levels.length ? picker(L.level, levels.map((l) => [l, levelName(l)]), s.thinking, (v) => save({ thinking: v }), false, L.agentLevel(a.name)) : null,
    settingMsg(a.id));
}


// ---------- new agent, and an agent's name and role ----------
const projectPath = (id, tail) => `/api/settings/projects/${encodeURIComponent(id)}/${tail}`;

/** Same refusals as the model lists, but a 400 here is about what was typed, and a 502 is Paseo failing to do the job. */
function formError(e, kind) {
  const L = t().set.err;
  if (e.status === 400) return L.form;
  if (e.status === 502) return kind === "create" ? L.create : L.rename;
  return settingError(e);
}

async function openNewAgent(project) {
  const form = { name: "", role: "", provider: "", model: "", thinking: "", task: "" };
  const mine = (S.newAgent = { options: null, form, busy: false, err: null });
  render();
  try {
    mine.options = await api(projectPath(project.id, "new-agent"));
    form.provider = mine.options.providers[0]?.id ?? "";
  } catch {
    mine.options = { providers: [] };
  }
  if (S.newAgent === mine) render();
}

async function createAgent(project) {
  const n = S.newAgent;
  const f = n.form;
  n.busy = true;
  n.err = null;
  document.activeElement?.blur?.();
  render();
  try {
    await jsonPost(projectPath(project.id, "new-agent"), {
      name: f.name, role: f.role, provider: f.provider,
      ...(f.model ? { model: f.model } : {}), ...(f.thinking ? { thinking: f.thinking } : {}), ...(f.task.trim() ? { task: f.task } : {}),
    });
    S.newAgent = null;
    S.agentSetFor = null; // the new agent has a model and level of its own to show
    await refresh();
  } catch (e) {
    n.busy = false;
    n.err = formError(e, "create");
  }
  render();
}

async function saveProfile(project, a) {
  const edit = S.editing;
  edit.busy = true;
  edit.err = null;
  document.activeElement?.blur?.();
  render();
  // Only what changed: sending the same name again would rename the Paseo workspace for nothing.
  const lookChanged = edit.gender !== (a.look?.gender ?? "") || edit.set !== (a.look?.set ?? "");
  const body = {
    ...(edit.name !== a.name ? { name: edit.name } : {}),
    ...(edit.role !== (a.role ?? "") ? { role: edit.role } : {}),
    ...(lookChanged ? { look: { gender: edit.gender, set: edit.set } } : {}),
  };
  try {
    if (Object.keys(body).length) await jsonPost(projectPath(project.id, `agents/${encodeURIComponent(a.id)}/profile`), body);
    S.editing = null;
    await refresh();
  } catch (e) {
    edit.busy = false;
    edit.err = formError(e, "rename");
  }
  render();
}

/** A one-line text field whose value lives in `target[key]`: the page may be rebuilt around it, what was typed is kept. */
function textField(label, target, key, max, hint) {
  return h("label", { class: "form-row" }, h("span", { text: label }),
    h("input", { class: "form-in", type: "text", maxlength: max, placeholder: hint ?? "", value: target[key], oninput: (ev) => { target[key] = ev.target.value; } }));
}

function newAgentForm(project) {
  const n = S.newAgent;
  const L = t().set;
  const cancel = h("button", { class: "btn", type: "button", text: L.cancelBtn, disabled: n.busy, onclick: () => { S.newAgent = null; render(); } });
  if (!n.options) return h("section", { class: "card agent-form" }, h("span", { class: "small muted", text: "…" }));
  if (!n.options.providers.length) return h("section", { class: "card agent-form" }, h("p", { class: "small muted", text: L.noProvider }), h("div", { class: "actions" }, cancel));
  const f = n.form;
  const provider = n.options.providers.find((p) => p.id === f.provider) ?? n.options.providers[0];
  const model = provider.models.find((m) => m.id === f.model);
  const choose = (key) => (v) => { f[key] = v; if (key === "provider") f.model = ""; if (key !== "thinking") f.thinking = ""; document.activeElement?.blur?.(); render(); };
  const task = h("textarea", { class: "form-in", rows: 4, maxlength: 4000, "aria-label": L.task, oninput: (ev) => { f.task = ev.target.value; } });
  task.value = f.task;
  return h("form", { class: "card agent-form", onsubmit: (ev) => { ev.preventDefault(); if (!n.busy) void createAgent(project); } },
    h("b", { text: L.newAgent }), h("p", { class: "small muted", text: L.newHint }),
    textField(L.name, f, "name", 60),
    textField(L.role, f, "role", 200, L.roleHint),
    picker(L.provider, n.options.providers.map((p) => [p.id, p.label]), provider.id, choose("provider"), n.busy),
    provider.models.length ? picker(L.model, [["", L.defaultOpt], ...provider.models.map((m) => [m.id, m.label])], f.model, choose("model"), n.busy) : null,
    model?.thinking.length ? picker(L.level, [["", L.defaultOpt], ...model.thinking.map((l) => [l, levelName(l)])], f.thinking, choose("thinking"), n.busy) : null,
    h("label", { class: "form-row stack" }, h("span", { text: L.task }), task),
    n.err ? h("div", { class: "small set-msg err", role: "alert", text: n.err }) : null,
    h("div", { class: "actions" },
      h("button", { class: "btn primary", type: "submit", disabled: n.busy || !f.name.trim(), text: n.busy ? L.creating : L.create }), cancel));
}

function profileForm(a, project) {
  const e = S.editing;
  const L = t().set;
  return h("form", { class: "set", onsubmit: (ev) => { ev.preventDefault(); if (!e.busy && e.name.trim()) void saveProfile(project, a); } },
    textField(L.name, e, "name", 60),
    textField(L.role, e, "role", 200, L.roleHint),
    // Its figure in the office (D-062): «as it comes» is the one its id gives, as before.
    picker(L.lookGender, [["", L.lookAuto], ["man", L.genders.man], ["woman", L.genders.woman]], e.gender, (v) => { e.gender = v; render(); }, e.busy),
    picker(L.lookSet, [["", L.sets.office], ["cartoon", L.sets.cartoon]], e.set === "office" ? "" : e.set, (v) => { e.set = v; render(); }, e.busy),
    e.err ? h("div", { class: "small set-msg err", role: "alert", text: e.err }) : null,
    h("div", { class: "actions" },
      h("button", { class: "btn primary", type: "submit", disabled: e.busy || !e.name.trim(), text: e.busy ? L.saving2 : L.save }),
      h("button", { class: "btn", type: "button", disabled: e.busy, text: L.cancelBtn, onclick: () => { S.editing = null; render(); } })));
}

/** Control or autonomous, per project (D-041). Turning autonomy on is the one change here with consequences, so it asks first. */
function modeBar(p) {
  const L = t().set.mode;
  const on = p.mode === "autonomous";
  const set = (mode) => applySetting("mode", `/api/settings/projects/${encodeURIComponent(p.id)}/mode`, { mode }, (r) => {
    p.mode = r.mode;
    const listed = S.overview?.projects.find((x) => x.id === p.id);
    if (listed) listed.mode = r.mode;
  });
  return h("div", { class: "modebar" },
    h("div", { class: "mode-head" },
      h("span", { class: "mode-title", text: L.title }),
      h("button", {
        class: "switch", type: "button", role: "switch", "aria-checked": String(on), "aria-label": `${L.title}: ${on ? L.autonomous : L.control}`,
        onclick: () => { if (on) void set("control"); else if (confirm(L.confirm(p.name))) void set("autonomous"); },
      }, h("span", { class: "knob", "aria-hidden": "true" })),
      h("b", { class: on ? "mode-on" : "", text: on ? L.autonomous : L.control }),
      settingMsg("mode")),
    h("p", { class: "small muted", text: on ? L.hintAutonomous : L.hintControl }),
    delegationBar(p));
}

/** Who follows the project (D-064): the PM, or the operational PM when there is one. */
function delegationBar(p) {
  const L = t().set;
  const d = p.delegation;
  if (!d?.name) return null;
  const set = (on) => applySetting("delegate", `/api/settings/projects/${encodeURIComponent(p.id)}/delegate`, { on }, (r) => {
    p.delegation = { ...d, on: r.delegated };
    const listed = S.overview?.projects.find((x) => x.id === p.id);
    if (listed) listed.delegation = p.delegation;
  });
  return [h("div", { class: "mode-head" },
    h("span", { class: "mode-title", text: L.opsTitle }),
    h("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(d.on), "aria-label": `${L.opsTitle}: ${d.on ? L.opsOn(d.name) : L.opsOff}`, onclick: () => void set(!d.on) },
      h("span", { class: "knob", "aria-hidden": "true" })),
    h("b", { class: d.on ? "mode-on" : "", text: d.on ? L.opsOn(d.name) : L.opsOff }),
    settingMsg("delegate")),
    h("p", { class: "small muted", text: d.on ? L.opsHintOn(d.name) : L.opsHintOff })];
}

// ---------- the plan ----------
const taskState = (status) => (/done/i.test(status) ? "done" : /progress|doing|wip/i.test(status) ? "doing" : "todo");
const GLYPH = { todo: "○", doing: "◐", done: "✔" };

/**
 * A project's macro plan (D-051): its goal, who was asked and who has not answered, and the work phase by phase,
 * every task with its owner and what it waits on. The plan is approved in the PM's thread, not here.
 */
function planSection(p) {
  const plan = p.plan;
  const L = t().plan;
  // Agents are named "<Project> <Job> - <Tool>": on the project's own page the project is the part that tells nothing.
  const name = (id) => {
    const full = p.agents.find((a) => a.id === id)?.name ?? id;
    return full.startsWith(`${p.name} `) && full.length > p.name.length + 1 ? full.slice(p.name.length + 1) : full;
  };
  const all = plan.phases.flatMap((ph) => ph.tasks);
  const byId = new Map(all.map((x) => [x.id.toUpperCase(), x]));
  const count = (tasks) => tasks.reduce((n, x) => { n[taskState(x.status)]++; return n; }, { todo: 0, doing: 0, done: 0 });
  const total = count(all);
  const waitingOn = (x) => x.dependsOn.filter((d) => { const dep = byId.get(d.toUpperCase()); return dep && taskState(dep.status) !== "done"; });

  const task = (x) => {
    const state = taskState(x.status);
    const waits = state === "done" ? [] : waitingOn(x);
    return h("li", { class: `ptask ${state}${x.proposed ? " proposed" : ""}${waits.length ? " waits" : ""}` },
      h("span", { class: "glyph", role: "img", title: L.state[state], "aria-label": L.state[state], text: GLYPH[state] }),
      h("div", { class: "pt-body" },
        h("div", { class: "pt-title", text: x.title }),
        h("div", { class: "pt-meta" },
          h("code", { text: x.id }),
          x.agent ? h("span", { text: name(x.agent) }) : null,
          x.proposed ? h("span", { class: "pill proposed", text: L.proposed }) : null,
          waits.length ? h("span", { class: "dep waiting", text: `⏳ ${L.waits(waits.join(", "))}` }) : x.dependsOn.length ? h("span", { class: "dep", text: L.after(x.dependsOn.join(", ")) }) : null)));
  };

  return h("section", { class: "card plan" },
    h("div", { class: "plan-head" },
      h("div", { class: "goal", text: plan.goal }),
      h("span", { class: `plan-status ${plan.status}`, text: L[plan.status] })),
    plan.status === "collecting"
      ? h("div", { class: "small muted", text: `${L.asked}: ${plan.asked.map(name).join(", ")}${plan.missing.length ? ` · ${L.missingFrom(plan.missing.map(name).join(", "))}` : ""}` })
      : null,
    all.length
      ? h("div", { class: "plan-progress" },
          h("div", { class: "pbar", role: "img", "aria-label": L.progress(total.done, all.length) }, ["done", "doing", "todo"].filter((k) => total[k]).map((k) => h("i", { class: k, style: `flex:${total[k]}` }))),
          h("span", { class: "small muted", text: L.progress(total.done, all.length) }))
      : null,
    h("div", { class: "phases" }, plan.phases.map((ph) =>
      h("section", { class: "phase" },
        h("div", { class: "ph-head" }, h("b", { text: ph.name === "—" ? L.noPhase : ph.name }), h("span", { class: "small muted", text: L.progress(count(ph.tasks).done, ph.tasks.length) })),
        h("ul", { class: "ptasks" }, ph.tasks.map(task))))));
}

// ---------- activity ----------
const ACT_ICON = { instruction: "✉", handoff: "🤝", status: "?", reply: "↩", report: "▤", task: "☑", delivered: "✓", expired: "⌛", commits: "⎇" };
const ACT_TYPES = ["instruction", "handoff", "status", "reply", "report", "task", "delivered", "expired", "commits"];
const ACT_PAGE = 100;

/** The register of the open project, oldest first as the hub sends it. `older` asks for the page before what is held. */
async function loadActivity(older = false) {
  const id = S.route.id;
  const A = S.activity;
  if (S.route.page !== "project") return false;
  if (A.project !== id) Object.assign(A, { project: id, entries: [], loaded: false, more: true, unsupported: false, fresh: 0 });
  else if (A.loaded && !older) return false;
  const before = older ? A.entries[0]?.id : undefined;
  let res;
  try {
    res = await api(`/api/activity?project=${encodeURIComponent(id)}&limit=${ACT_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
  } catch {
    A.unsupported = true; // an older hub: no register, no tab
    A.loaded = true;
    return true;
  }
  if (S.route.id !== id) return false;
  const known = new Set(A.entries.map((e) => e.id));
  const got = res.entries.filter((e) => !known.has(e.id));
  A.entries = older ? [...got, ...A.entries] : res.entries;
  A.more = res.entries.length >= ACT_PAGE;
  A.loaded = true;
  return true;
}

/** Open the register of a project, on one agent's steps if given: from an agent's card, or from the chat's summary. */
function showActivity(projectId, agent = null) {
  S.activity.agent = agent;
  S.activity.type = null;
  S.activity.fresh = 0;
  S.tab = "activity";
  if (S.route.page === "project" && S.route.id === projectId) {
    render();
    document.querySelector(".tabs")?.scrollIntoView({ block: "start" });
  } else location.hash = `#/p/${encodeURIComponent(projectId)}`;
}

function activityTab(p) {
  const A = S.activity;
  const L = t().activity;
  if (!A.loaded) return h("p", { class: "muted", text: "…" });
  const name = (id) => {
    const full = p.agents.find((a) => a.id === id)?.name ?? id;
    return full.startsWith(`${p.name} `) && full.length > p.name.length + 1 ? full.slice(p.name.length + 1) : full;
  };
  const of = (e) => e.activity?.type ?? "report";
  const involves = (e, id) => e.activity?.agent === id || e.activity?.to === id;
  const byAgent = A.entries.filter((e) => !A.agent || involves(e, A.agent));
  const counts = {};
  for (const e of byAgent) counts[of(e)] = (counts[of(e)] ?? 0) + 1;
  const shown = byAgent.filter((e) => !A.type || of(e) === A.type).reverse(); // newest first
  const chip = (label, pressed, onclick) => h("button", { class: `chip${pressed ? " on" : ""}`, type: "button", "aria-pressed": String(pressed), text: label, onclick });
  const agentChip = (id) => h("button", { class: "chip mini", type: "button", title: L.allAgents, text: name(id), onclick: () => { A.agent = A.agent === id ? null : id; render(); } });

  const entry = (e) => {
    const type = of(e);
    const lines = e.text.split("\n");
    const long = lines.length > 3 || e.text.length > 260;
    const open = A.open.has(e.id);
    const head = long && !open ? `${lines.slice(0, 3).join("\n").slice(0, 240)}…` : e.text;
    return h("li", { class: `act ${type}` },
      h("span", { class: "act-ico", "aria-hidden": "true", text: ACT_ICON[type] ?? "·" }),
      h("div", { class: "act-body" },
        h("div", { class: "act-head" },
          h("b", { text: L.types[type] ?? type }),
          e.activity?.agent ? agentChip(e.activity.agent) : null,
          e.activity?.to ? [h("span", { class: "muted", "aria-hidden": "true", text: "→" }), agentChip(e.activity.to)] : null,
          h("span", { class: "small muted", title: fmt(e.at), text: ago(e.at) })),
        h("div", { class: "act-text", text: head }),
        long ? h("button", { class: "link", type: "button", "aria-expanded": String(open), text: open ? L.showLess : L.showMore, onclick: () => { open ? A.open.delete(e.id) : A.open.add(e.id); render(); } }) : null));
  };

  return h("div", { class: "activity" },
    h("div", { class: "act-filters", role: "group", "aria-label": L.title },
      chip(`${L.all} · ${byAgent.length}`, !A.type, () => { A.type = null; render(); }),
      ACT_TYPES.filter((k) => counts[k]).map((k) => chip(`${L.filters[k]} · ${counts[k]}`, A.type === k, () => { A.type = A.type === k ? null : k; render(); }))),
    p.agents.length > 1
      ? h("div", { class: "act-filters", role: "group", "aria-label": L.allAgents },
          chip(L.allAgents, !A.agent, () => { A.agent = null; render(); }),
          p.agents.map((a) => chip(name(a.id), A.agent === a.id, () => { A.agent = A.agent === a.id ? null : a.id; render(); })))
      : null,
    shown.length ? h("ul", { class: "acts" }, shown.map(entry)) : h("p", { class: "muted", text: L.empty }),
    A.more ? h("button", { class: "btn", type: "button", text: L.older, onclick: async () => { await loadActivity(true); render(); } }) : null);
}

// ---------- a new project ----------
const PROJECT_STEPS = ["folder", "repository", "leftoff", "registry", "paseo"];

/** What the hub offers for making a project (D-056); a hub without it has no "New project". True when it has news. */
async function loadProjectOptions() {
  if (S.projectOptions !== undefined) return false;
  try {
    S.projectOptions = await api("/api/projects/options");
  } catch {
    S.projectOptions = false;
  }
  return S.projectOptions !== false;
}

/** A refusal of the hub in the owner's language, by what kind it was. */
function projectError(e) {
  const L = t().newProject.err;
  if (e.type === "invalid_name") return { empty: L.empty, too_long: L.tooLong(S.projectOptions?.nameMax ?? 60), bad_chars: L.badChars, reserved: L.reserved, no_id: L.noId }[e.reason] ?? L.badChars;
  if (e.type === "exists") return { project: L.existsProject, folder: L.existsFolder, paseo: L.existsPaseo }[e.existing?.kind] ?? L.existsProject;
  if (e.type === "git_identity") return L.gitIdentity;
  if (e.type === "paseo_unavailable") return L.paseoUnavailable;
  if (e.type === "paseo_refused") return L.paseoRefused;
  return L.other;
}

/** The form opens where it was asked for: in the plot's place, or under the title (`top`). */
function openNewProject(at = "plot") {
  S.newProject = { at, name: "", purpose: "", check: { state: "idle" }, job: null, busy: false, error: null, timer: 0, poll: 0 };
  render();
  setTimeout(() => { const f = document.getElementById("np-name"); f?.focus(); f?.scrollIntoView({ block: "center" }); }, 0);
}

function closeNewProject() {
  const N = S.newProject;
  if (N) { clearTimeout(N.timer); clearInterval(N.poll); }
  S.newProject = null;
  // A focused field holds the page still (picking): Escape is pressed in one, so let go of it first.
  if (document.activeElement instanceof HTMLElement && document.activeElement.closest(".np-form")) document.activeElement.blur();
  render();
  // Back to what opened it, so a keyboard is not left at the top of the page.
  if (N && !N.job) document.querySelector(N.at === "top" ? "#np-open" : ".plot")?.focus();
}

/** What the name will make, asked of the hub as the owner types: the folder, or why not. It repaints its own line only. */
function checkName() {
  const N = S.newProject;
  clearTimeout(N.timer);
  const name = N.name.trim();
  if (!name) { N.check = { state: "idle" }; paintCheck(); return; }
  N.check = { state: "checking" };
  paintCheck();
  N.timer = setTimeout(async () => {
    try {
      const r = await jsonPost("/api/projects/check", { name });
      if (S.newProject === N && N.name.trim() === name) N.check = { state: "ok", folder: r.folder, id: r.id };
    } catch (e) {
      if (S.newProject === N && N.name.trim() === name) N.check = { state: "error", message: projectError(e), existing: e.existing, raw: e.message };
    }
    if (S.newProject === N) paintCheck();
  }, 300);
}

/** The check line and the Create button, updated in place so a field being typed in is never rebuilt. */
function paintCheck() {
  const N = S.newProject;
  const line = document.getElementById("np-check");
  const btn = document.getElementById("np-create");
  const L = t().newProject;
  if (line) {
    const c = N.check;
    line.className = `small np-check ${c.state}`;
    line.replaceChildren(...(c.state === "checking" ? [L.checking] : c.state === "ok" ? [L.willBe(c.folder)] : c.state === "error"
      ? [c.message, c.existing?.kind === "project" && c.existing.id ? [" ", h("a", { href: `#/p/${encodeURIComponent(c.existing.id)}`, text: L.seeIt })] : null].flat().filter(Boolean) : []));
    line.title = c.raw ?? "";
  }
  if (btn) btn.disabled = N.busy || N.check.state !== "ok";
}

async function createProject() {
  const N = S.newProject;
  if (N.busy || N.check.state !== "ok") return;
  N.busy = true;
  N.error = null;
  document.activeElement?.blur?.();
  render();
  try {
    const res = await jsonPost("/api/projects", { name: N.name.trim(), ...(N.purpose.trim() ? { purpose: N.purpose.trim() } : {}) });
    N.job = res.job;
    S.jobs.set(res.job.id, res.job);
    // The hub tells us at every step (the SSE event `project`); asking now and then covers an event that did not arrive.
    N.poll = setInterval(async () => {
      try { noteJob((await api(`/api/projects/jobs/${encodeURIComponent(N.job.id)}`)).job ?? null); } catch { /* the next one */ }
    }, 3000);
  } catch (e) {
    N.error = projectError(e);
    N.busy = false;
  }
  render();
}

async function loadJobs() {
  if (!S.projectOptions || S.jobsLoaded || S.jobsLoading) return false;
  S.jobsLoading = true;
  let error = null;
  try {
    for (const job of (await api("/api/projects/jobs")).jobs ?? []) S.jobs.set(job.id, job);
  } catch (e) {
    error = e;
  }
  S.jobsLoading = false;
  // Asked again at the next refresh unless it answered, or it has no list at all (then only this page's creation is followed).
  S.jobsLoaded = listOutcome(error) !== "retry";
  return !error;
}

/** A job as the hub reports it (from the event, from asking, or from the list): kept, and followed if it is the one being made here. */
function noteJob(job) {
  if (!job?.id) return;
  S.jobs.set(job.id, job);
  const N = S.newProject;
  if (N?.job && job.id === N.job.id) {
    N.job = job;
    S.jobErrors.delete(job.id);
    if (job.status === "done") {
      clearInterval(N.poll);
      render();
      const id = job.projectId;
      if (id) S.guided = id;
      setTimeout(() => { if (S.newProject === N) { S.newProject = null; if (id) location.hash = `#/p/${encodeURIComponent(id)}`; else render(); } }, 1100);
      void refresh();
      return;
    }
    if (job.status === "failed") clearInterval(N.poll);
    else if (!N.poll) N.poll = setInterval(async () => { try { noteJob((await api(`/api/projects/jobs/${encodeURIComponent(N.job.id)}`)).job ?? null); } catch { /* the next one */ } }, 3000);
  } else if (job.status === "done" && S.route.page === "overview") void refresh();
  render();
}

/** Resume a stopped creation from the step that failed (never redoing what worked). */
async function retryJob(job) {
  S.jobErrors.set(job.id, "…");
  render();
  try {
    noteJob((await jsonPost(retryPath(job), {})).job);
    S.jobErrors.delete(job.id);
  } catch (e) {
    S.jobErrors.set(job.id, projectError(e));
  }
  render();
}

/** Leave a stopped creation as it is: what was made stays (nothing is asked of the hub), and the Home stops showing the card. */
function leaveJob(job) {
  S.leftJobs = leave(S.leftJobs, job);
  try { localStorage.setItem(LEFT_KEY, writeLeft(S.leftJobs)); } catch { /* private mode */ }
  if (S.newProject?.job?.id === job.id) { closeNewProject(); return; }
  render();
}

const STEP_MARK = { pending: "○", running: "◐", done: "✔", failed: "✖" };

/** A creation as a card: its five steps, and what it says when it is done or stopped, with Retry and Leave it as it is. */
function jobCard(job) {
  const L = t().newProject;
  const byId = new Map((job.steps ?? []).map((x) => [x.id, x]));
  const failed = failedStep(job);
  const err = S.jobErrors.get(job.id);
  return h("section", { class: "card np-card", "aria-live": "polite" },
    h("b", { text: job.name ?? "" }),
    h("ul", { class: "np-steps" }, PROJECT_STEPS.map((id) => {
      const step = byId.get(id) ?? { id, status: "pending" };
      return h("li", { class: `np-step ${step.status}` },
        h("span", { class: "np-mark", "aria-hidden": "true", text: STEP_MARK[step.status] ?? "○" }),
        h("span", { text: L.steps[id] }),
        h("span", { class: "sr-only", text: step.status }));
    })),
    job.status === "done" ? h("p", { class: "np-ok", role: "status", text: `✔ ${L.done}` }) : null,
    failed ? h("p", { class: "set-msg err", role: "alert", title: failed.error?.detail ?? failed.error?.message ?? "", text: projectError({ type: failed.error?.type }) }) : null,
    err && err !== "…" ? h("p", { class: "set-msg err", role: "alert", text: err }) : null,
    job.status === "done" ? h("div", { class: "actions" }, h("a", { class: "btn primary", href: `#/p/${encodeURIComponent(job.projectId ?? "")}`, text: L.open }))
      : failed ? h("div", { class: "actions" },
          canRetry(job) ? h("button", { class: "btn primary", type: "button", disabled: err === "…", text: err === "…" ? L.retrying : L.retry, onclick: () => void retryJob(job) }) : null,
          h("button", { class: "btn", type: "button", text: L.leave, onclick: () => leaveJob(job) })) : null);
}

/** The creations that are running or stopped and are not the one being made in the form, from any origin, at the top of the Home. */
function jobBanners() {
  if (!S.projectOptions) return null;
  const open = cardsToShow(S.jobs.values(), { mine: S.newProject?.job?.id ?? null, left: S.leftJobs });
  return open.length ? h("div", { class: "np-jobs" }, open.map(jobCard)) : null;
}

function newProjectForm() {
  const N = S.newProject;
  const L = t().newProject;
  const opts = S.projectOptions || {};
  return h("form", { class: "card np-form", onsubmit: (ev) => { ev.preventDefault(); void createProject(); }, onkeydown: (ev) => { if (ev.key === "Escape" && !N.busy) closeNewProject(); } },
    h("label", { class: "form-row stack" }, h("span", { text: L.name }),
      h("input", { id: "np-name", class: "form-in", type: "text", required: true, maxlength: opts.nameMax ?? 60, autocomplete: "off", value: N.name, oninput: (ev) => { N.name = ev.target.value; checkName(); } })),
    h("p", { id: "np-check", class: "small np-check idle", role: "status", "aria-live": "polite" }),
    h("label", { class: "form-row stack" }, h("span", { text: L.purpose }),
      h("input", { class: "form-in", type: "text", maxlength: 200, value: N.purpose, oninput: (ev) => { N.purpose = ev.target.value; } })),
    opts.paseo === "unavailable" ? h("p", { class: "small warn", text: L.paseoDown }) : null,
    N.error ? h("p", { class: "set-msg err", role: "alert", text: N.error }) : null,
    h("div", { class: "actions" },
      h("button", { id: "np-create", class: "btn primary", type: "submit", disabled: true, text: N.busy ? L.creating : L.create }),
      h("button", { class: "btn", type: "button", disabled: N.busy, text: L.cancel, onclick: closeNewProject })));
}

/** The last place of the Home's rooms: an empty plot (the form, once opened), only on a hub that can make projects. */
function newProjectSlot() {
  if (!S.projectOptions) return null;
  const N = S.newProject;
  const L = t().newProject;
  if (N?.job) return jobCard(N.job);
  if (N) {
    const form = newProjectForm();
    queueMicrotask(paintCheck);
    return form;
  }
  const { width, height } = plotLayout();
  const canvas = h("canvas", { width: width * RES, height: height * RES, "aria-hidden": "true" });
  const ctx = canvas.getContext("2d");
  if (ctx) drawPlot(adapt(ctx), L.tile);
  return h("button", { class: "plot", type: "button", onclick: () => openNewProject("plot") }, canvas, h("span", { class: "sr-only", text: L.tile }));
}

// ---------- setting up a new project ----------

/**
 * The page of a project with no agent, or one being set up: an invitation to add the first agent (with the form already
 * open and role ideas to start from) and, once there is one, to add another or to finish. Nothing here promises work
 * that is not there: the room is dark until someone works in it.
 */
function guideCard(p) {
  const L = t().guide;
  const first = p.agents.length === 0;
  const apply = (preset) => { const n = S.newAgent; if (!n) return; n.form.name = preset.name; n.form.role = preset.role; render(); };
  return h("section", { class: "card np-guide" },
    h("b", { text: first ? L.first : L.added }),
    h("p", { class: "small muted", text: first ? L.hintFirst : L.hintAdded }),
    first && S.newAgent && S.newAgent.options?.providers?.length
      ? h("div", { class: "act-filters", role: "group", "aria-label": L.ideas },
          h("span", { class: "small muted", text: `${L.ideas}:` }),
          L.presets.map((preset) => h("button", { class: "chip", type: "button", text: preset.label, onclick: () => apply(preset) })))
      : null,
    first ? null : h("div", { class: "actions" },
      h("button", { class: "btn primary", type: "button", text: L.another, onclick: () => void openNewAgent(p) }),
      h("button", { class: "btn", type: "button", text: L.done, onclick: () => { S.guided = null; render(); document.querySelector(".office-card")?.scrollIntoView({ block: "start" }); } })));
}

/** A project with no agent yet opens the form for the first one, once for each visit. True when it did. */
function maybeGuide(p) {
  if (!S.agentSet || S.newAgent || p.agents.length > 0 || S.guideOpened.has(p.id)) return false;
  S.guideOpened.add(p.id);
  S.guided = p.id;
  void openNewAgent(p);
  return true;
}

// ---------- project page ----------
function agentCard(a, project) {
  const name = a.name;
  return h("div", { class: "card acard" },
    h("div", { class: "top2" }, liveDot(a.live), h("span", { class: "nm", text: name }),
      S.agentSet ? h("button", { class: "btn gear", type: "button", title: t().set.edit(name), "aria-label": t().set.edit(name), text: "✎", onclick: () => { S.editing = { id: a.id, name: a.name, role: a.role ?? "", gender: a.look?.gender ?? "", set: a.look?.set ?? "", busy: false, err: null }; render(); } }) : null,
      h("span", { class: "small muted", text: t().live[a.live] }), h("span", { style: "flex:1" }), a.status !== "none" ? status(a.status) : h("span", { class: "small muted", text: t().status.none })),
    S.editing?.id === a.id ? profileForm(a, project) : null,
    a.summary ? h("p", { class: "sum", text: a.summary }) : null,
    agentSettings(a, project),
    h("div", { class: "meta" },
      h("span", { text: ago(a.lastAt) }), a.branch ? h("span", { text: a.branch }) : null,
      a.awaiting ? h("span", { text: `⏳ ${t().awaiting}` }) : null,
      a.pendingInbox ? h("span", { text: t().inbox(a.pendingInbox) }) : null,
      a.unreportedCommits ? h("span", { text: t().unreported(a.unreportedCommits) }) : null),
    h("div", { class: "actions" },
      h("button", { class: "btn", type: "button", text: t().askUpdate, onclick: () => send(t().askUpdateMsg(name)) }),
      h("button", { class: "btn", type: "button", text: t().resume, onclick: () => { if (confirm(t().confirmResume(name))) send(`/resume ${project.id} ${a.id}`); } }),
      S.activity.unsupported ? null : h("button", { class: "btn", type: "button", text: t().activity.title, onclick: () => showActivity(project.id, a.id) })));
}

function kcard(c, project) {
  const agent = project.agents.find((a) => a.id === c.agent);
  const stale = c.column === "doing" && c.at && Date.now() - Date.parse(c.at) > 6 * 3_600_000 && agent?.live !== "running";
  return h("div", { class: `kcard ${c.column}${stale ? " stale" : ""}`, title: stale ? t().stale : "" },
    h("div", { class: "t", text: c.title }),
    c.phase || c.proposed || c.auto || c.dependsOn?.length
      ? h("div", { class: "kbadges" },
          c.phase ? h("span", { class: "pill in-phase", text: c.phase }) : null,
          c.proposed ? h("span", { class: "pill proposed", text: t().plan.proposed }) : null,
          c.auto ? h("span", { class: "pill auto", text: t().plan.auto }) : null,
          c.dependsOn?.length ? h("span", { class: "dep", text: t().plan.after(c.dependsOn.join(", ")) }) : null)
      : null,
    c.detail ? h("pre", { text: c.detail }) : null,
    c.agent || c.at ? h("div", { class: "by" }, h("span", { text: c.agent ?? "" }), h("span", { text: c.at ? ago(c.at) : "" })) : null);
}

function board(b, project) {
  const col = (key, cards, extra) =>
    h("section", { class: `col ${key}` },
      h("div", { class: "ch" }, h("span", { text: t()[key] }), h("span", { class: "n", text: String(key === "done" ? b.doneTotal : cards.length) })),
      cards.length ? cards.map((c) => kcard(c, project)) : h("div", { class: "empty-col", text: t().emptyCol }),
      extra);
  return h("div", { class: "board" },
    col("todo", b.todo), col("doing", b.doing), col("blocked", b.blocked),
    col("done", b.done, b.doneTotal > b.done.length ? h("div", { class: "more", text: t().moreDone(b.doneTotal - b.done.length) }) : null));
}

function reportItem(r) {
  const open = S.openReports.has(r.file);
  const head = h("button", { class: "h", type: "button", "aria-expanded": String(open), onclick: () => { open ? S.openReports.delete(r.file) : S.openReports.add(r.file); render(); } },
    status(r.status), h("b", { text: r.agent }), h("span", { class: "what", text: r.done[0] ?? r.doing[0] ?? r.blocked[0] ?? r.next[0] ?? "" }), h("span", { class: "small muted", title: fmt(r.at), text: ago(r.at) }));
  const sect = (label, items) => (items.length ? h("div", {}, h("b", { text: label }), items.length === 1 ? h("span", { text: items[0] }) : h("ul", {}, items.map((x) => h("li", { text: x })))) : null);
  const L = t().labels;
  return h("div", { class: "card rep" }, head,
    open ? h("div", { class: "body" },
      sect(L.done, r.done), sect(L.doing, r.doing), sect(L.blocked, r.blocked), sect(L.next, r.next), sect(L.findings, r.findings), sect(L.decisions, r.decisions),
      r.question ? sect(L.ask, [[r.question.text, ...r.question.options.map((o, i) => `${i + 1}. ${o}`)].join(" · ")]) : null,
      r.commits.length ? sect(L.commits, [r.commits.join(", ")]) : null,
      r.body ? h("div", { class: "muted", style: "white-space:pre-wrap", text: r.body }) : null) : null);
}

function renderProject() {
  const d = S.detail;
  if (!d) return [h("p", { class: "muted", text: "…" })];
  const p = d.project;
  const tabs = [...(S.activity.unsupported ? [] : [["activity", S.activity.fresh ? `${t().activity.title} · ${t().activity.fresh(S.activity.fresh)}` : t().activity.title]]), ["reports", t().reports], ["decisions", t().decisions], ["commits", t().commits]];
  const tabBody = {
    activity: () => activityTab(p),
    reports: () => (d.reports.length ? h("div", { class: "tl" }, d.reports.map(reportItem)) : h("p", { class: "muted", text: t().noReports })),
    decisions: () => (d.decisions.length ? h("div", { class: "list" }, d.decisions.map((x) => h("div", { class: "card li" }, h("span", { class: "when", text: x.at }), h("span", { text: x.text }), h("span", { class: "small muted", text: x.by })))) : h("p", { class: "muted", text: t().noDecisions })),
    commits: () => (d.commits.length ? h("div", { class: "list" }, d.commits.map((c) => h("div", { class: "card li" }, h("code", { text: c.sha }), h("span", { style: "flex:1", text: c.subject }), h("span", { class: "when", title: fmt(c.at), text: ago(c.at) })))) : h("p", { class: "muted", text: t().noCommits })),
  };
  return [
    h("div", { class: "crumbs" }, h("a", { href: "#/", text: t().back })),
    h("div", { class: "phead" },
      h("div", {}, h("h1", { text: p.name }), p.purpose ? h("p", { text: p.purpose }) : null),
      h("div", { style: "display:flex;gap:8px;align-items:center" }, status(p.headline),
        p.mutedUntil ? h("span", { class: "small muted", text: `🔕 ${t().muted}` }) : h("button", { class: "btn", type: "button", text: `🔕 ${t().mute}`, onclick: () => send(`/mute ${p.id} 4`) }))),
    p.mode ? modeBar(p) : null,
    d.asks.length ? [h("h2", { text: t().needsYou }), h("div", { class: "asks" }, d.asks.map(askCard))] : null,
    [h("h2", { text: t().office }), officeSection(p)],
    S.guided === p.id && S.agentSet ? guideCard(p) : null,
    h("div", { class: "h2row" }, h("h2", { text: t().agents(p.agents.length) }),
      S.agentSet && !S.newAgent ? h("button", { class: "btn", type: "button", text: `+ ${t().set.newAgent}`, onclick: () => void openNewAgent(p) }) : null),
    S.newAgent ? newAgentForm(p) : null,
    // Said once for the team, not on every card: the locked model lists carry it as a tooltip.
    S.agentSet?.some((x) => x.reachable && !x.canSetModel && x.models.length) ? h("p", { class: "small muted", text: t().set.modelLocked }) : null,
    p.agents.length ? h("div", { class: "agent-row" }, p.agents.map((a) => agentCard(a, p))) : S.guided === p.id ? null : h("p", { class: "muted", text: t().noAgents }),
    // While a new project is being set up there is no work to show yet: an empty board would only promise it.
    S.guided === p.id && !p.agents.length ? null : [
      p.plan ? [h("h2", { text: t().plan.title }), planSection(p)] : null,
      h("h2", { text: t().work }),
      board(d.board, p),
    ],
    S.guided === p.id && !p.agents.length ? null : [
      h("div", { class: "tabs", role: "tablist" }, tabs.map(([key, label]) => h("button", { role: "tab", type: "button", "aria-selected": String(S.tab === key), text: label, onclick: () => { S.tab = key; if (key === "activity") S.activity.fresh = 0; render(); } }))),
      (tabBody[S.tab] ?? tabBody.reports)(),
    ],
  ];
}

// ---------- chat ----------
const SRC = () => ({ telegram: t().fromTelegram, web: t().fromWeb, console: "console", hub: "" });
/**
 * The chat is built once and its parts are updated in place. Replacing the message list would send it back to
 * the top (a detached element forgets its scroll) and cut a swipe short, which is what happened every refresh:
 * the owner scrolled up to read, and was thrown back to the first message.
 */
const chatParts = { root: null, pinned: true, saved: 0 };
const nearBottom = (m) => m.scrollHeight - m.scrollTop - m.clientHeight < 80;

function chatSkeleton(chat) {
  if (chatParts.root === chat) return chatParts;
  const input = h("textarea", { id: "input", rows: 1, "aria-label": "", enterkeyhint: "send" });
  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(140, input.scrollHeight)}px`; };
  const submit = () => { const v = input.value.trim(); if (v) { input.value = ""; grow(); send(v); } };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); } });
  const msgs = h("div", { class: "msgs", id: "msgs" });
  // Where the owner has got to, kept while the list is out of sight (on a phone, on the other tab) and reads as zero.
  msgs.addEventListener("scroll", () => { if (msgs.clientHeight > 0) { chatParts.pinned = nearBottom(msgs); chatParts.saved = msgs.scrollTop; } }, { passive: true });
  const parts = { header: h("div", { class: "ch" }), drawer: h("div"), msgs, draft: h("div"), quick: h("div", { class: "quick" }), input, grow, sendBtn: h("button", { class: "btn primary", type: "submit" }), sig: {} };
  chat.replaceChildren(parts.header, parts.drawer, msgs, parts.draft,
    h("div", { class: "composer" }, parts.quick, h("form", { onsubmit: (ev) => { ev.preventDefault(); submit(); } }, input, parts.sendBtn)));
  Object.assign(chatParts, parts, { root: chat });
  return chatParts;
}

/** Back on the chat tab: the list reads as it was left, at the bottom if that is where it was. */
function restoreChatScroll() {
  const m = chatParts.msgs;
  if (m && m.clientHeight > 0) m.scrollTop = chatParts.pinned ? m.scrollHeight : chatParts.saved;
}

/** Update `slot` only when what it shows changed: `sig` is a cheap summary of that. */
function refill(slot, key, sig, build) {
  if (chatParts.sig[key] === sig) return false;
  chatParts.sig[key] = sig;
  slot.replaceChildren(...[build()].flat(Infinity).filter(Boolean));
  return true;
}

function renderChat() {
  const chat = document.getElementById("chat");
  const c = chatSkeleton(chat);
  const thread = threadParam();
  const names = new Map((S.overview?.projects ?? []).map((p) => [p.id, p.name]));
  const title = thread ? (names.get(thread) ?? thread) : t().general;
  const typing = S.busy.has(thread ?? "general");

  c.input.placeholder = t().placeholder;
  c.input.setAttribute("aria-label", t().placeholder);
  c.sendBtn.textContent = t().send;

  refill(c.header, "header", [S.lang, title, S.error, S.setOpen, Boolean(S.overview)].join("|"), () => [
    h("b", { text: `${t().pm} · ${title}` }), S.error ? h("span", { class: "err", text: S.error }) : null,
    S.overview ? h("button", { class: "btn gear", type: "button", title: t().set.title, "aria-label": t().set.title, "aria-expanded": String(S.setOpen), text: "⚙", onclick: toggleSettings }) : null]);

  // A model list being chosen from is left alone until the choice is made.
  if (!picking(c.drawer)) refill(c.drawer, "drawer", S.setOpen ? JSON.stringify([S.lang, S.pmSet, S.setMsg]) : "closed", () => (S.setOpen ? pmSettings() : null));

  refill(c.draft, "draft", JSON.stringify([S.lang, S.draft]), () => S.draft && h("div", { class: "draft" },
    h("b", { text: t().draft(S.draft.agent) }), h("div", { class: "small", style: "margin-top:2px", text: S.draft.summary }),
    h("div", { class: "actions" },
      h("button", { class: "btn primary", type: "button", text: t().approve, onclick: () => send(t().yes) }),
      h("button", { class: "btn danger", type: "button", text: t().cancel, onclick: () => send(t().no) }),
      h("button", { class: "btn", type: "button", text: t().edit, onclick: () => document.getElementById("input")?.focus() }))));

  refill(c.quick, "quick", `${S.lang}|${thread}`, () => (thread ? t().quickProject : t().quickGeneral).map((q) => h("button", { class: "chip", type: "button", text: q, onclick: () => send(q) })));

  // The messages: rebuilt only when there is something new, and then without moving the owner's place.
  const listSig = [S.lang, thread, typing, S.feed.length, S.feed[0]?.id, S.feed.at(-1)?.id, names.size].join("|");
  if (c.sig.msgs === listSig) return;
  const threadChanged = c.sig.msgsThread !== thread;
  c.sig.msgs = listSig;
  c.sig.msgsThread = thread;
  const visible = c.msgs.clientHeight > 0;
  const keep = visible ? c.msgs.scrollTop : c.saved;
  const pinned = threadChanged || (visible ? nearBottom(c.msgs) : c.pinned);
  let lastDay = "";
  const rows = [];
  const live = liveChoices(S.feed);
  for (const e of S.feed) {
    const day = dayKey(e.at);
    if (day !== lastDay) { rows.push(h("div", { class: "day", text: dayLabel(e.at) })); lastDay = day; }
    const who = e.role === "owner" ? "" : e.kind === "push" ? t().pushed : "PM";
    const logged = e.kind === "log";
    rows.push(h("div", { class: `msg ${e.role}${logged ? " log" : ""}`, title: logged ? t().notSent : "" },
      h("div", { class: "meta2" },
        !thread && e.projectId ? h("span", { class: "proj", text: names.get(e.projectId) ?? e.projectId }) : null,
        who ? h("span", { text: who }) : null,
        logged ? h("span", { text: `🗒 ${t().notSent}` }) : h("span", { text: SRC()[e.source] || "" }), h("span", { title: fmt(e.at), text: clock(e.at) })),
      e.text,
      // «🗂️ N notices…»: what the hub held back from the chat is in the project's activity register.
      e.projectId && e.role === "pm" && e.text.startsWith("🗂️") ? h("div", { class: "msg-link" }, h("button", { class: "link", type: "button", text: t().activity.open, onclick: () => showActivity(e.projectId) })) : null,
      // The buttons it came with in chat: a tap says the reply in the message's own thread.
      live.has(e.id) ? h("div", { class: "opts msg-choices" }, choicesOf(e).map((c) =>
        h("button", { class: "chip", type: "button", text: c.label, disabled: S.busy.has(threadOf(e)), onclick: () => send(c.reply, e.projectId) }))) : null));
  }
  c.msgs.replaceChildren(...rows, ...(typing ? [h("div", { class: "typing", text: t().typing })] : []));
  c.pinned = pinned;
  c.saved = pinned ? c.msgs.scrollHeight : keep;
  if (visible) c.msgs.scrollTop = pinned ? c.msgs.scrollHeight : keep;
  c.grow();
}

async function toggleSettings() {
  S.setOpen = !S.setOpen;
  if (S.setOpen) { renderChat(); await loadPmSettings(); }
  renderChat();
}

/** Say `text` to the PM in a thread: the one on screen, or a message's own (a project's id, null for the general one). */
async function send(text, project = threadParam()) {
  S.error = null;
  // Whatever the owner writes decides the draft shown (yes, no, or a change the PM then redrafts): its box goes now,
  // so a yes is never asked twice. If the PM shows a new draft, its answer brings the box back (reloadDraft).
  S.draft = null;
  try {
    const { entry } = await api("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, text }) });
    if (!S.feed.some((e) => e.id === entry.id)) S.feed.push(entry);
    noteFeed(entry);
    S.busy.add(project ?? "general");
    S.chatTab = true;
  } catch (e) {
    S.error = e.message;
  }
  renderChat();
  renderTabs();
  syncLayout();
}

// ---------- shell ----------
function renderTabs() {
  document.getElementById("tabbar").replaceChildren(
    h("button", { type: "button", "aria-selected": String(!S.chatTab), text: t().overview, onclick: () => { S.chatTab = false; syncLayout(); renderTabs(); } }),
    h("button", { type: "button", "aria-selected": String(S.chatTab), text: t().pm, onclick: () => { S.chatTab = true; syncLayout(); renderTabs(); } }));
}
function syncLayout() {
  const was = (chatParts.msgs?.clientHeight ?? 0) > 0;
  document.getElementById("app").classList.toggle("show-chat", S.chatTab);
  // The chat has just come into view (phone): it was display:none, so it reads as scrolled to the top.
  if (!was && (chatParts.msgs?.clientHeight ?? 0) > 0) restoreChatScroll();
}

function render() {
  const main = document.getElementById("main");
  const scroll = main.scrollTop;
  renderTop();
  if (picking(main)) {
    // Mid-choice: leave the page as it is; the next render (when the list closes) catches up.
  } else if (S.overview) main.replaceChildren(...(S.route.page === "project" ? renderProject() : renderOverview()).flat(Infinity).filter(Boolean));
  else main.replaceChildren(h("p", { class: "muted", text: S.error ?? "…" }));
  main.scrollTop = scroll;
  renderChat();
  renderTabs();
  syncLayout();
}

// A new width can mean a different number of rooms to a row: lay the building out again.
let laidOutAt = 0;
let resizing = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizing);
  resizing = setTimeout(() => {
    const width = document.getElementById("main").clientWidth;
    if (width > 0 && Math.abs(width - laidOutAt) > 40) { laidOutAt = width; render(); }
  }, 250);
});

function parseRoute() {
  const m = /^#\/p\/(.+)$/.exec(location.hash);
  S.route = m ? { page: "project", id: decodeURIComponent(m[1]) } : { page: "overview", id: null };
}
window.addEventListener("hashchange", async () => {
  parseRoute();
  S.detail = null;
  S.agentSet = null;
  S.agentSetFor = null;
  S.setMsg = null;
  S.newAgent = null;
  S.editing = null;
  if (S.newProject) { clearTimeout(S.newProject.timer); clearInterval(S.newProject.poll); }
  S.newProject = null;
  S.jobsLoaded = false;
  S.feed = [];
  S.draft = null;
  S.chatTab = false;
  render();
  await refresh();
  document.getElementById("main").scrollTop = 0;
});

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("feed", (ev) => {
    const e = JSON.parse(ev.data);
    noteFeed(e); // the office shows the PM at work whichever thread the chat panel has open
    const thread = threadParam();
    if (thread ? e.projectId !== thread : false) return;
    if (!S.feed.some((x) => x.id === e.id)) S.feed.push(e);
    renderChat();
    if (e.role === "pm") void reloadDraft();
  });
  es.addEventListener("typing", (ev) => {
    const { project, on } = JSON.parse(ev.data);
    on ? S.busy.add(project) : S.busy.delete(project);
    if (!on) pmEnds(project);
    renderChat();
  });
  // The hub says the moment the PM writes to an agent; noteContacts() only covers a hub that does not (or an event missed).
  es.addEventListener("contact", (ev) => {
    const { project, agent, kind } = JSON.parse(ev.data);
    contact(project, agent, kind, true);
  });
  // A step between the PM and the agents (D-052): into the register of the project it is about, never into the chat.
  es.addEventListener("activity", (ev) => {
    const e = JSON.parse(ev.data);
    const A = S.activity;
    if (S.route.page !== "project" || A.project !== e.projectId || !A.loaded || A.entries.some((x) => x.id === e.id)) return;
    A.entries.push(e);
    if (S.tab !== "activity") A.fresh++;
    render();
  });
  // The creation of a project, step by step (D-056): the whole job at every change, whoever started it.
  es.addEventListener("project", (ev) => noteJob(JSON.parse(ev.data)));
  es.addEventListener("refresh", () => refresh());
}

parseRoute();
render();
await refresh();
connectEvents();
setInterval(() => refresh(), 10_000);
