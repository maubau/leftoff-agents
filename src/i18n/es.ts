import type { Messages } from "./types.ts";

const INBOX_REASON: Record<string, string> = {
  "the Paseo session is closed": "la sesión de Paseo está cerrada",
  "agent unknown": "no lo conozco",
  "not run by Paseo": "no lo gestiona Paseo",
};

export const es: Messages = {
  name: "Español",

  report: {
    and: "y",
    taskFallback: "su tarea",
    finished: (who, what) => `✅ ${who} ha terminado: ${what}.`,
    decisions: (items) => `Decisiones: ${items}`,
    findings: (items) => `Hallazgos: ${items}`,
    next: (items) => `Siguiente: ${items}`,
    nowIdle: "Ahora está parado. ¿Qué debe hacer?",
    blocked: (who, reason) => `⛔ ${who} está bloqueado: ${reason}.`,
    noReason: "motivo no indicado",
    recommends: (option) => `Recomienda: ${option}`,
    doneSoFar: (items) => `Hecho hasta ahora: ${items}`,
    needsYou: (who) => `❓ ${who} te necesita.`,
    nextStep: (items) => `Siguiente paso: ${items}`,
    done: (items) => `Hecho: ${items}`,
    idle: (who, lastWork) => `💤 ${who} está parado.${lastWork ? ` Último trabajo: ${lastWork}.` : ""}`,
    suggests: (items) => `Propuestas: ${items}`,
    whatShouldItDo: "¿Qué debe hacer?",
  },

  delivery: {
    reason: (english) => INBOX_REASON[english] ?? "no está disponible ahora",
    draftBusy: "🟢 Está trabajando: lo leerá enseguida, sin interrumpirse.",
    draftIdle: "💤 Está parado: este mensaje lo pondrá en marcha.",
    sentBusy: "Estaba trabajando: lo lee enseguida.",
    sentIdle: "Estaba parado: arranca ahora.",
    unreachable: (why) => `📥 No está disponible ahora (${why}): el mensaje esperará en su bandeja hasta su próxima sesión.`,
    draftHeader: (agent, project) => `📨 Borrador para ${agent} — ${project}`,
    approveHint: (ttl) => `Responde «sí» para enviarlo, «no» para descartarlo, o dime qué cambiar. (Válido ${ttl >= 60 ? `${Math.round(ttl / 60)} h` : `${ttl} min`}.)`,
    sent: (agent, project) => `Enviado a ${agent} (${project}).`,
    willTell: "Te aviso cuando responda.",
    choiceSend: "✅ Sí, enviar",
    choiceDrop: "✖ No",
    yesWord: "sí",
    noWord: "no",
  },

  handoff: {
    header: (from, to, project) => `🤝 Traspaso — ${from} → ${to} (${project})`,
    instruction: (p) =>
      [
        `Petición de tu compañero ${p.from}${p.role ? ` (${p.role})` : ""}, transmitida por el jefe de proyecto con la aprobación del responsable:`,
        "",
        `«${p.ask}»`,
        "",
        `Contexto: su informe ${p.report}${p.branch ? `, rama ${p.branch}` : ""}${p.commits.length ? `, commits ${p.commits.join(", ")}` : ""}.`,
        "Si te toca a ti, hazlo; si no, o necesitas algo antes, dilo en tu informe.",
        `Cuando termines, informa como siempre. Si ${p.from} tiene que saber o hacer algo, añade --handoff "${p.fromId}: <qué>".`,
      ].join("\n"),
    unknownTarget: (from, to, ask, team) => `🤝 ${from} necesita «${ask}» de «${to}», pero ningún agente del proyecto coincide. Equipo: ${team}. Dime quién debe hacerlo, o da un rol a los agentes (leftoff agents role).`,
    decision: (from, to, ask) => `Traspaso aprobado: ${from} → ${to}: ${ask}`,
    reply: (who, from) => `Respuesta de ${who} a la petición de ${from}`,
    expired: (from, to) => `⌛ El traspaso ${from} → ${to} caducó sin respuesta. Pídeme que lo reenvíe si aún importa.`,
  },

  newAgent: {
    firstPrompt: (p) =>
      [
        `Eres ${p.name}, un nuevo agente del equipo de ${p.project}, creado por el responsable desde Leftoff.`,
        ...(p.role ? [`Tu rol: ${p.role}.`] : []),
        "",
        ...(p.task ? [`Tu primera tarea:`, "", p.task] : [`Todavía no hay tarea: conoce el proyecto (README, informes recientes en .leftoff/), luego informa con estado idle y espera instrucciones.`]),
        "",
        `Tus compañeros y cómo informar están en el briefing que recibes al empezar la sesión. Cuando termines, informa como siempre.`,
      ].join("\n"),
  },

  office: {
    title: (project) => `🏢 ${project} — la oficina`,
    states: { working: "trabajando", blocked: "bloqueado", needs: "te necesita", awaiting: "espera respuesta", done: "terminó", idle: "parado" },
    handoff: (from, to, ask) => `🤝 ${from} → ${to}: ${ask}`,
    whichProject: "¿Qué proyecto? Escribe /oficina <proyecto>, o envíalo en el tema del proyecto.",
    noAgents: (project) => `Todavía no hay agentes en ${project}: aparecen tras su primer informe.`,
  },

  unreported: {
    head: (count, branch) => `⚠️ ${count} commit${count === 1 ? "" : "s"}${branch ? ` en ${branch}` : ""} sin informe.`,
    andMore: (count) => `…y ${count} más`,
    askSummary: "¿Quieres que le pida un resumen al agente?",
  },

  standup: {
    title: (weekday) => `📋 Stand-up del ${weekday}`,
    noReports: "ningún informe desde que lo sigo",
    reportsLastDay: (count) => `${count} informe${count === 1 ? "" : "s"} en las últimas 24 h`,
    quietDays: (days) => `parado desde hace ${days} ${days === 1 ? "día" : "días"}`,
    next: "siguiente",
    unreportedCommits: (count) => `⚠️ ${count} commit${count === 1 ? "" : "s"} sin informe`,
    nothingNew: "sin novedades",
    notReported: "no registrado",
    usd: (value) => `${value.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`,
    spend: (dev, pm) => `Gasto de los últimos 7 días: desarrollo ${dev}, PM ${pm}`,
  },

  limits: {
    windowName: (product, label) => `${product}, ventana ${label}`,
    atTime: (hhmm) => `a las ${hhmm}`,
    tomorrowAt: (hhmm) => `mañana a las ${hhmm}`,
    dateAt: (date, hhmm) => `${date} a las ${hhmm}`,
    inRel: (when, rel) => `${when} (en ${rel})`,
    now: "ahora",
    reachedWhen: (name, when) => `⛔ ${name} ha alcanzado su límite. Se desbloquea ${when}.`,
    reachedPlain: (name) => `⛔ ${name} ha alcanzado su límite.`,
    reachedUnknown: (name) => `⛔ ${name} ha alcanzado su límite. No sé cuándo se desbloquea: te aviso en cuanto vuelva a funcionar.`,
    shouldBeBack: (name, when) => `✅ ${name} debería estar disponible de nuevo (el límite vencía ${when}).`,
    back: (name) => `✅ ${name} está disponible de nuevo.`,
    windowReset: (name) => `✅ ${name} está disponible de nuevo: la ventana se ha reiniciado.`,
    used: (percent) => `${Math.round(percent)} % usado`,
    warn: (name, percent, when) => `⚠️ ${name}: ${Math.round(percent)} % usado.${when ? ` Se reinicia ${when}.` : ""}`,
    summaryTitle: "Límites de suscripciones",
    limitReached: "límite alcanzado",
    fiveHours: "5 horas",
    weekly: "semanal",
    hours: (n) => `${n} h`,
  },

  spoken: {
    codeBlock: " Hay un detalle de código disponible en el texto. ",
    pullRequest: (n) => `la pull request número ${n}`,
    file: " un archivo",
    link: "un enlace",
    commit: "un commit",
    technicalRef: "una referencia técnica",
    rest: "El resto está en el texto.",
  },

  pm: {
    capped: (cap) =>
      `El PM ha alcanzado su tope de gasto de este mes (${cap.toFixed(2)} $), así que no consulto el modelo. ` +
      "Los informes siguen disponibles con `leftoff brief`. Puedes subir el tope en config.yaml (pm.budget.monthlyUsd).",
    budgetWarn: (spent, cap) => `ℹ️ Gasto del PM este mes: ${spent.toFixed(2)} $ de un tope de ${cap.toFixed(2)} $.`,
    refused: "El modelo ha rechazado esta petición. Prueba a reformularla.",
    empty: "No he podido formular una respuesta. Inténtalo de nuevo en un momento.",
    answerIn: "Spanish",
  },

  tasks: {
    addedDecision: "Añadidas al backlog por el PM",
    requestWhy: "Petición del propietario",
  },

  hub: {
    restartScheduled: (count) => ` Reinicio automático programado para ${count === 1 ? "el agente detenido" : `${count} agentes detenidos`}.`,
    resumeInstruction: (product) =>
      `[leftoff] El límite de ${product} se ha reiniciado. Retoma ahora exactamente donde lo dejaste. Primero comprueba el estado actual del proyecto; después continúa y envía el informe Leftoff habitual.`,
    autoRestartDecision: "Reinicio automático tras el reinicio del límite",
    restartUnreachable: (name) => `⚠️ ${name}: el límite se ha reiniciado, pero la sesión que se detuvo ya no está disponible. No he reiniciado ninguna otra sesión en su lugar.`,
    restartAsked: (name, queued) => `▶️ ${name}: límite reiniciado; he pedido que retome${queued ? "; en cola porque no está disponible" : ""}.`,
    replyStatus: (who) => `Actualización de ${who} (pedida por el PM)`,
    replyInstruction: (who) => `Respuesta de ${who} a tu instrucción`,
    sayYesToSend: " Di «sí» para enviarlo, o dime qué cambiar.",
    draftShownNote: (summary) => `[Borrador mostrado en el chat, a la espera de un sí: ${summary}]`,
    statusQuestion:
      "[leftoff] El project manager pide una actualización. En cuanto puedas, escribe un informe Leftoff (leftoff report): qué has hecho, qué estás haciendo, si estás bloqueado y qué necesitas. Si has terminado, dilo. No cambies tu plan por esto.",
    dropped: "👍 Descartado, no se ha enviado nada.",
    modelDown: (waiting) => `Ahora no puedo responder: el modelo no está disponible.${waiting ? " El borrador de antes sigue esperando: «sí» lo envía, «no» lo descarta." : ""}`,
    projectGone: "Ese proyecto ya no existe: no se ha enviado nada.",
    capReached: (cap) => `Ya he enviado ${cap} instrucciones en las últimas 24 horas, mi propio tope. No envío más; sube commands.maxPerDay si hace falta.`,
    instructionDecision: (agent, summary) => `Instrucción a ${agent}: ${summary}`,
    instructionWhy: (prompt) => `Aprobada en el chat y transmitida por el PM. Texto enviado:\n${prompt}`,
    sendFailed: "No he podido enviarlo. El borrador se ha perdido: dime otra vez qué quieres.",
    noTranscriber: "De momento solo entiendo texto: las notas de voz no están activadas (falta la clave del transcriptor).",
    voiceTooLong: (seconds, max) => `La nota de voz es demasiado larga (${seconds} s, máximo ${max} s). Divídela o escríbela.`,
    heardNothing: "🎙️ No he entendido nada con claridad. Inténtalo de nuevo o escríbelo.",
    notSure: (text) => `🎙️ No estoy seguro de haber entendido: «${text}». Grábalo otra vez o escríbelo.`,
    transcribeFailed: "No he podido transcribir la nota de voz. Inténtalo de nuevo o escríbelo.",
    whichProjectMute: "¿Qué proyecto? Ej. /mute clipforge 4 (horas)",
    muted: (project, until) => `🔕 ${project} silenciado hasta ${until}`,
    unmuted: (project) => `🔔 ${project ?? "Proyecto"} activo de nuevo.`,
    quietOn: (start, end) => `🌙 Las horas de silencio están activas de ${start} a ${end}. Desactívalas con /quiet off.`,
    quietOff: "🔔 Las horas de silencio están desactivadas: las actualizaciones llegan a cualquier hora. Actívalas con /quiet on.",
    whichProjectResume: "¿Qué proyecto? Usa /resume <proyecto> [agente].",
    whichAgentResume: (project, agents) => `¿Qué agente? Usa /resume ${project} <${agents || "agente"}>.`,
    manualResumeInstruction:
      "[leftoff] Retoma ahora donde lo dejaste. Primero comprueba el estado actual del proyecto; después continúa y envía el informe Leftoff habitual.",
    manualResumeDecision: "Reinicio manual solicitado a",
    resumeAsked: (agent, project) => `▶️ ${agent} (${project}): he pedido que retome ahora.`,
    resumeQueued: (agent, project) => `📥 ${agent} (${project}): mensaje de reinicio en cola; no está disponible ahora.`,
    voiceUnavailable: "Las respuestas de voz no están disponibles (falta la clave de Deepgram).",
    voiceLabel: (mode) =>
      ({
        mirror: "auto: te respondo con voz cuando me escribes con voz",
        always: "siempre: cada respuesta y el stand-up llevan también voz",
        never: "nunca: solo texto",
      })[mode],
    voiceStatus: (label) => `🔊 Voz: ${label}.\nCambia con /voz on, /voz off o /voz auto.`,
    languageNow: (name, options) => `🌐 Idioma: ${name}. Cambia con /idioma ${options}.`,
    languageUnknown: (options) => `No conozco ese idioma. Elige uno de: ${options}.`,
    alertsStatus: (level) => ({ critical: '🔔 Avisos: solo críticos — un agente bloqueado o que te necesita, un límite alcanzado, la respuesta a lo que pediste. El resto está en el panel. Cambia con /alerts normal o /alerts all.', normal: '🔔 Avisos: normales — los críticos más el trabajo terminado y las advertencias de límite. Cambia con /alerts critical o /alerts all.', all: '🔔 Avisos: todos — todo, incluidos los commits sin informe. Cambia con /alerts critical o /alerts normal.' })[level],
    alertsUnknown: 'Elige entre: critical, normal, all.',
    help: "Escríbeme con normalidad: «¿en qué punto estamos?». Comandos: /overview, /oficina [proyecto], /resume <proyecto> [agente], /quiet on|off, /voice on|off|auto, /language <código>, /alerts critical|normal|all, /mute <proyecto> [horas], /unmute <proyecto>.",
  },
};
