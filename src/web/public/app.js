// Leftoff control panel. No framework, no build step: the page renders what /api/* says and
// never works out a status itself. Every string that came from a report goes in as text, never as HTML.

import { CODES, LOCALES, STR, strings } from "/i18n.js";
import { drawOffice, officeLayout, officeModel } from "/office.js";

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
  error: null,
  sending: false,
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
  if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({}))).error ?? res.statusText), { status: res.status });
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
async function loadFeed() {
  const thread = threadParam();
  const res = await api(`/api/feed?limit=150${thread ? `&project=${encodeURIComponent(thread)}` : ""}`);
  S.feed = res.entries;
  S.draft = res.draft;
  S.busy = new Set(res.busy);
}

let refreshing = false;
async function refresh(all = true) {
  if (refreshing) return;
  refreshing = true;
  try {
    await loadOverview();
    await Promise.all([loadDetail(), loadFeed()]);
    S.error = null;
  } catch (e) {
    S.error = e.status === 401 ? e.message : t().loadErr;
  } finally {
    refreshing = false;
  }
  if (all) render();
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
  // whatever the log last said. The PM budget and Codex have a number; Claude Code never does.
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
    o ? h("div", { class: "meters" }, o.limits.map(meter), o.pm.budgetUsd > 0 ? meter({ product: t().pmSpend, label: "", usedPercent: (o.pm.spentUsd / o.pm.budgetUsd) * 100, resetsAt: null, reached: o.pm.spentUsd >= o.pm.budgetUsd, valueText: `$${o.pm.spentUsd.toFixed(2)} / $${o.pm.budgetUsd}` }) : null) : null);
}

function countsBar(c) {
  const total = c.todo + c.doing + c.blocked + c.done;
  if (!total) return h("div", { class: "bar empty", "aria-hidden": "true" });
  return h("div", { class: "bar", role: "img", "aria-label": `${c.todo} ${t().todo}, ${c.doing} ${t().doing}, ${c.blocked} ${t().blocked}, ${c.done} ${t().done}` },
    ["todo", "doing", "blocked", "done"].filter((k) => c[k]).map((k) => h("i", { class: k, style: `flex:${c[k]}` })));
}
function legend(c) {
  return h("div", { class: "legend" }, ["todo", "doing", "blocked", "done"].map((k) => h("span", { class: k, text: `${c[k]} ${t()[k].toLowerCase()}` })));
}

function agentChips(p) {
  const running = p.agents.filter((a) => a.live === "running").length;
  return h("div", { class: "agents" },
    p.agents.length
      ? [p.agents.map((a) => h("span", { class: "agent-chip", title: `${a.name}: ${t().live[a.live]}` }, liveDot(a.live), a.name)),
         running ? h("span", { class: "small muted", style: "align-self:center", text: t().working(running) }) : null]
      : h("span", { class: "small muted", text: t().noAgents }));
}

// ---------- the office ----------
/** A pixel office for a project: drawn by /office.js, animated by the loop below. */
function officeCanvas(p, cls) {
  const model = officeModel(p);
  const { width, height } = officeLayout(model);
  const canvas = h("canvas", { class: `office ${cls}`, width, height, role: "img", "aria-label": officeLabel(p, model) });
  canvas._office = model;
  paint(canvas, 0);
  return canvas;
}

function officeLabel(p, model) {
  return `${t().office} ${p.name}: ` + model.agents.map((a) => `${a.id} ${t().states[a.state]}`).join(", ");
}

function paint(canvas, time) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !canvas._office) return;
  drawOffice({ rect: (x, y, w, hh, colour) => { ctx.fillStyle = colour; ctx.fillRect(x, y, w, hh); } }, canvas._office, time);
}

const STILL = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
let lastFrame = 0;
function animate(now) {
  // About eight frames a second is plenty for pixel art, and cheap; nothing moves when the tab is hidden.
  if (!document.hidden && now - lastFrame > 120) {
    lastFrame = now;
    for (const canvas of document.querySelectorAll("canvas.office")) paint(canvas, STILL ? 0 : now);
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

function officeSection(p) {
  const name = (id) => p.agents.find((a) => a.id === id)?.name ?? id;
  const model = officeModel(p);
  return h("section", { class: "card office-card" },
    officeCanvas(p, "big"),
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

function projectCard(p) {
  const unreported = p.agents.reduce((n, a) => n + a.unreportedCommits, 0);
  return h("a", { class: "card pcard", href: `#/p/${encodeURIComponent(p.id)}` },
    h("div", { class: "head" }, h("span", { class: "name", text: p.name }), status(p.headline)),
    p.purpose ? h("p", { class: "purpose", text: p.purpose }) : null,
    p.agents.length ? officeCanvas(p, "mini") : null,
    h("div", {}, h("div", { class: "small muted", text: t().agents(p.agents.length) }), agentChips(p)),
    h("div", { style: "display:grid;gap:6px" }, countsBar(p.counts), legend(p.counts)),
    h("div", { class: "meta" },
      h("span", { text: `${t().lastActivity} ${ago(p.lastActivityAt)}` }),
      h("span", { text: p.branch }),
      p.dirtyFiles ? h("span", { text: t().dirty(p.dirtyFiles) }) : null,
      unreported ? h("span", { text: t().unreported(unreported) }) : null,
      p.mutedUntil ? h("span", { text: `🔕 ${t().muted}` }) : null));
}

function askCard(a) {
  const say = (option) => prefill(t().askAnswer(a.projectName, a.agent[0].toUpperCase() + a.agent.slice(1), option));
  return h("div", { class: `card ask ${a.status}` },
    h("div", { class: "head" }, status(a.status), h("a", { href: `#/p/${encodeURIComponent(a.projectId)}`, text: a.projectName }), h("span", { class: "small muted", text: `${a.agent} · ${ago(a.at)}` })),
    h("div", { class: "text", text: a.text }),
    a.options.length ? h("div", { class: "opts" }, a.options.map((o) => h("button", { class: `chip${o === a.recommend ? " rec" : ""}`, type: "button", title: o === a.recommend ? t().rec : "", onclick: () => say(o), text: o === a.recommend ? `${o} ★` : o }))) : null);
}

function renderOverview() {
  const o = S.overview;
  return [
    h("h2", { text: t().needsYou }),
    o.asks.length ? h("div", { class: "asks" }, o.asks.map(askCard)) : h("p", { class: "muted", text: t().nothingNeeded }),
    h("h2", { text: t().projects }),
    h("div", { class: "grid" }, o.projects.map(projectCard)),
  ];
}

// ---------- project page ----------
function agentCard(a, project) {
  const name = a.name;
  return h("div", { class: "card acard" },
    h("div", { class: "top2" }, liveDot(a.live), h("span", { class: "nm", text: name }), h("span", { class: "small muted", text: t().live[a.live] }), h("span", { style: "flex:1" }), a.status !== "none" ? status(a.status) : h("span", { class: "small muted", text: t().status.none })),
    a.summary ? h("p", { class: "sum", text: a.summary }) : null,
    h("div", { class: "meta" },
      h("span", { text: ago(a.lastAt) }), a.branch ? h("span", { text: a.branch }) : null,
      a.awaiting ? h("span", { text: `⏳ ${t().awaiting}` }) : null,
      a.pendingInbox ? h("span", { text: t().inbox(a.pendingInbox) }) : null,
      a.unreportedCommits ? h("span", { text: t().unreported(a.unreportedCommits) }) : null),
    h("div", { class: "actions" },
      h("button", { class: "btn", type: "button", text: t().askUpdate, onclick: () => send(t().askUpdateMsg(name)) }),
      h("button", { class: "btn", type: "button", text: t().resume, onclick: () => { if (confirm(t().confirmResume(name))) send(`/resume ${project.id} ${a.id}`); } })));
}

function kcard(c, project) {
  const agent = project.agents.find((a) => a.id === c.agent);
  const stale = c.column === "doing" && c.at && Date.now() - Date.parse(c.at) > 6 * 3_600_000 && agent?.live !== "running";
  return h("div", { class: `kcard ${c.column}${stale ? " stale" : ""}`, title: stale ? t().stale : "" },
    h("div", { class: "t", text: c.title }),
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
  const tabs = [["reports", t().reports], ["decisions", t().decisions], ["commits", t().commits]];
  const tabBody = {
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
    d.asks.length ? [h("h2", { text: t().needsYou }), h("div", { class: "asks" }, d.asks.map(askCard))] : null,
    p.agents.length ? [h("h2", { text: t().office }), officeSection(p)] : null,
    h("h2", { text: t().agents(p.agents.length) }),
    p.agents.length ? h("div", { class: "agent-row" }, p.agents.map((a) => agentCard(a, p))) : h("p", { class: "muted", text: t().noAgents }),
    h("h2", { text: t().work }),
    board(d.board, p),
    h("div", { class: "tabs", role: "tablist" }, tabs.map(([key, label]) => h("button", { role: "tab", type: "button", "aria-selected": String(S.tab === key), text: label, onclick: () => { S.tab = key; render(); } }))),
    tabBody[S.tab](),
  ];
}

// ---------- chat ----------
const SRC = () => ({ telegram: t().fromTelegram, web: t().fromWeb, console: "console", hub: "" });
function renderChat() {
  const chat = document.getElementById("chat");
  const keepText = chat.querySelector("textarea")?.value ?? "";
  const wasFocused = document.activeElement === chat.querySelector("textarea");
  const pinned = (() => { const m = chat.querySelector(".msgs"); return !m || m.scrollHeight - m.scrollTop - m.clientHeight < 80; })();

  const thread = threadParam();
  const names = new Map((S.overview?.projects ?? []).map((p) => [p.id, p.name]));
  const title = thread ? (names.get(thread) ?? thread) : t().general;
  let lastDay = "";
  const rows = [];
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
      e.text));
  }
  const typing = S.busy.has(thread ?? "general");
  const msgs = h("div", { class: "msgs", id: "msgs" }, rows, typing ? h("div", { class: "typing", text: t().typing }) : null);

  const draft = S.draft && h("div", { class: "draft" },
    h("b", { text: t().draft(S.draft.agent) }), h("div", { class: "small", style: "margin-top:2px", text: S.draft.summary }),
    h("div", { class: "actions" },
      h("button", { class: "btn primary", type: "button", text: t().approve, onclick: () => send(t().yes) }),
      h("button", { class: "btn danger", type: "button", text: t().cancel, onclick: () => send(t().no) }),
      h("button", { class: "btn", type: "button", text: t().edit, onclick: () => document.getElementById("input")?.focus() })));

  const input = h("textarea", { id: "input", rows: 1, placeholder: t().placeholder, "aria-label": t().placeholder, enterkeyhint: "send" });
  input.value = keepText;
  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(140, input.scrollHeight)}px`; };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); }
  });
  const submit = () => { const v = input.value.trim(); if (v) { input.value = ""; grow(); send(v); } };
  const quick = (thread ? t().quickProject : t().quickGeneral);

  chat.replaceChildren(...[
    h("div", { class: "ch" }, h("b", { text: `${t().pm} · ${title}` }), S.error ? h("span", { class: "err", text: S.error }) : null),
    msgs, draft,
    h("div", { class: "composer" },
      h("div", { class: "quick" }, quick.map((q) => h("button", { class: "chip", type: "button", text: q, onclick: () => send(q) }))),
      h("form", { onsubmit: (ev) => { ev.preventDefault(); submit(); } }, input, h("button", { class: "btn primary", type: "submit", text: t().send })))].filter(Boolean));
  if (wasFocused) input.focus();
  grow();
  if (pinned) msgs.scrollTop = msgs.scrollHeight;
}

function prefill(text) {
  S.chatTab = true;
  render();
  const input = document.getElementById("input");
  if (input) { input.value = text; input.focus(); input.dispatchEvent(new Event("input")); }
}

async function send(text) {
  S.error = null;
  try {
    const { entry } = await api("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: threadParam(), text }) });
    if (!S.feed.some((e) => e.id === entry.id)) S.feed.push(entry);
    S.busy.add(threadParam() ?? "general");
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
    h("button", { type: "button", "aria-selected": String(S.chatTab), text: t().pm, onclick: () => { S.chatTab = true; syncLayout(); renderTabs(); const m = document.getElementById("msgs"); if (m) m.scrollTop = m.scrollHeight; } }));
}
function syncLayout() {
  document.getElementById("app").classList.toggle("show-chat", S.chatTab);
}

function render() {
  const main = document.getElementById("main");
  const scroll = main.scrollTop;
  renderTop();
  if (S.overview) main.replaceChildren(...(S.route.page === "project" ? renderProject() : renderOverview()).flat(Infinity).filter(Boolean));
  else main.replaceChildren(h("p", { class: "muted", text: S.error ?? "…" }));
  main.scrollTop = scroll;
  renderChat();
  renderTabs();
  syncLayout();
}

function parseRoute() {
  const m = /^#\/p\/(.+)$/.exec(location.hash);
  S.route = m ? { page: "project", id: decodeURIComponent(m[1]) } : { page: "overview", id: null };
}
window.addEventListener("hashchange", async () => {
  parseRoute();
  S.detail = null;
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
    const thread = threadParam();
    if (thread ? e.projectId !== thread : false) return;
    if (!S.feed.some((x) => x.id === e.id)) S.feed.push(e);
    renderChat();
  });
  es.addEventListener("typing", (ev) => {
    const { project, on } = JSON.parse(ev.data);
    on ? S.busy.add(project) : S.busy.delete(project);
    renderChat();
  });
  es.addEventListener("refresh", () => refresh());
}

parseRoute();
render();
await refresh();
connectEvents();
setInterval(() => refresh(), 10_000);
