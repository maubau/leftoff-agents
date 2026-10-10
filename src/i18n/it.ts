import type { Messages } from "./types.ts";

/** "l'83%", "l'11%", "il 60%": the article follows how the number is pronounced (otto, undici). */
const usedPhrase = (percent: number) => {
  const n = Math.round(percent);
  const vowel = n === 8 || n === 11 || (n >= 80 && n <= 89);
  return `usato ${vowel ? "l'" : "il "}${n}%`;
};

const INBOX_REASON: Record<string, string> = {
  "the Paseo session is closed": "la sessione Paseo è chiusa",
  "agent unknown": "non lo conosco",
  "not run by Paseo": "non è gestito da Paseo",
};

export const it: Messages = {
  name: "Italiano",

  report: {
    and: "e",
    taskFallback: "il suo compito",
    finished: (who, what) => `✅ ${who} ha finito: ${what}.`,
    decisions: (items) => `Decisioni: ${items}`,
    findings: (items) => `Scoperte: ${items}`,
    next: (items) => `Prossimo: ${items}`,
    nowIdle: "Ora è fermo. Cosa deve fare?",
    blocked: (who, reason) => `⛔ ${who} è bloccato: ${reason}.`,
    noReason: "motivo non indicato",
    recommends: (option) => `Consiglia: ${option}`,
    doneSoFar: (items) => `Fatto finora: ${items}`,
    needsYou: (who) => `❓ ${who} ha bisogno di te.`,
    nextStep: (items) => `Prossimo passo: ${items}`,
    done: (items) => `Fatto: ${items}`,
    idle: (who, lastWork) => `💤 ${who} è fermo.${lastWork ? ` Ultimo lavoro: ${lastWork}.` : ""}`,
    suggests: (items) => `Proposte: ${items}`,
    whatShouldItDo: "Cosa deve fare?",
  },

  delivery: {
    reason: (english) => INBOX_REASON[english] ?? "non è raggiungibile ora",
    draftBusy: "🟢 Sta lavorando: glielo consegno quando finisce il turno in corso, senza interromperlo.",
    draftIdle: "💤 È fermo: ripartirà con questo messaggio.",
    sentBusy: "Sta lavorando: glielo consegno quando finisce il turno in corso, senza interromperlo.",
    sentIdle: "Era fermo: riparte ora.",
    delivered: (agent, project, live) => (live ? `📨 Consegnato a ${agent} (${project}): aveva finito il turno.` : `📨 ${agent} (${project}) non è più in Paseo: il messaggio è nella sua inbox, per la prossima sessione.`),
    unreachable: (why) => `📥 Non è raggiungibile ora (${why}): il messaggio resterà in coda e lo leggerà alla prossima sessione.`,
    draftHeader: (agent, project) => `📨 Bozza per ${agent} — ${project}`,
    approveHint: (ttl) => `Rispondi «sì» per inviarla, «no» per annullarla, o dimmi cosa cambiare. (Valida ${ttl >= 60 ? `${Math.round(ttl / 60)} ore` : `${ttl} minuti`}.)`,
    sent: (agent, project) => `Inviato a ${agent} (${project}).`,
    willTell: "Ti avviso quando risponde.",
    choiceSend: "✅ Sì, invia",
    choiceDrop: "✖ No",
    yesWord: "sì",
    noWord: "no",
  },

  handoff: {
    header: (from, to, project) => `🤝 Passaggio di consegne — ${from} → ${to} (${project})`,
    instruction: (p) =>
      [
        `Richiesta dal tuo collega ${p.from}${p.role ? ` (${p.role})` : ""}, inoltrata dal project manager con l'approvazione del responsabile:`,
        "",
        `«${p.ask}»`,
        "",
        `Contesto: il suo report ${p.report}${p.branch ? `, branch ${p.branch}` : ""}${p.commits.length ? `, commit ${p.commits.join(", ")}` : ""}.`,
        "Se è compito tuo, fallo; se non lo è, o ti serve prima qualcosa, scrivilo nel report.",
        `Quando hai finito, fai il report come sempre. Se ${p.from} deve sapere o fare qualcosa, aggiungi --handoff "${p.fromId}: <cosa>".`,
      ].join("\n"),
    unknownTarget: (from, to, ask, team) => `🤝 ${from} chiede «${ask}» a “${to}”, ma nessun agente del progetto corrisponde. Squadra: ${team}. Dimmi chi deve farlo, oppure assegna un ruolo agli agenti (leftoff agents role).`,
    decision: (from, to, ask) => `Passaggio di consegne approvato: ${from} → ${to}: ${ask}`,
    reply: (who, from) => `Risposta di ${who} alla richiesta di ${from}`,
    expired: (from, to) => `⌛ Il passaggio di consegne ${from} → ${to} è scaduto senza risposta. Chiedimi di rimandarlo, se serve ancora.`,
  },

  modes: {
    name: { control: "controllata", autonomous: "autonoma" },
    changed: (project, mode) => (mode === "autonomous" ? `🤖 ${project}: modalità autonoma. Quello che mi chiedi, e gli handoff tra colleghi, partono senza aspettare il tuo sì; ti avviso ogni volta. Le azioni distruttive o irreversibili, e le mie iniziative, aspettano ancora te.` : `✋ ${project}: modalità controllata. Ogni istruzione a un agente aspetta il tuo sì.`),
    already: (project, mode) => `${project} è già in modalità ${({ control: "controllata", autonomous: "autonoma" })[mode]}.`,
    confirm: (project) => `Attivo la modalità autonoma per ${project}? Le tue istruzioni e gli handoff tra colleghi partiranno senza chiederti prima.`,
    risky: `⚠️ Modalità autonoma, ma questa serve il tuo sì: sembra un'azione distruttiva o irreversibile.`,
    initiative: `Modalità autonoma, ma è una mia idea, non una tua richiesta: serve il tuo sì.`,
    handoffForwarded: (from, to, project, ask) => `🤝 Passato in automatico (modalità autonoma): ${from} → ${to} (${project})\n«${ask}»`,
    autoWhy: `modalità autonoma: inviata senza chiedere il sì`,
    decision: (mode) => `Modalità del project manager: ${({ control: "controllata", autonomous: "autonoma" })[mode]}`,
  },

  newAgent: {
    firstPrompt: (p) =>
      [
        `Sei ${p.name}, un nuovo agente del team di ${p.project}, creato dal responsabile da Leftoff.`,
        ...(p.role ? [`Il tuo ruolo: ${p.role}.`] : []),
        "",
        ...(p.task ? [`Il tuo primo compito:`, "", p.task] : [`Per ora nessun compito: conosci il progetto (README, report recenti in .leftoff/), poi fai il report con stato idle e aspetta istruzioni.`]),
        "",
        `I colleghi e come fare il report sono nel briefing che ricevi all'inizio della sessione. Quando hai finito, fai il report come sempre.`,
      ].join("\n"),
  },

  office: {
    title: (project) => `🏢 ${project} — l'ufficio`,
    states: { working: "al lavoro", blocked: "bloccato", needs: "ha bisogno di te", awaiting: "attende risposta", done: "ha finito", idle: "fermo" },
    handoff: (from, to, ask) => `🤝 ${from} → ${to}: ${ask}`,
    whichProject: "Quale progetto? Scrivi /ufficio <progetto>, oppure mandalo nel topic del progetto.",
    noAgents: (project) => `Nessun agente in ${project} per ora: compaiono dopo il loro primo report.`,
  },

  unreported: {
    head: (count, branch) => `⚠️ ${count} commit${branch ? ` su ${branch}` : ""} senza report.`,
    andMore: (count) => `…e altri ${count}`,
    askSummary: "Vuoi che chieda all'agente un riepilogo?",
  },

  standup: {
    title: (weekday) => `📋 Stand-up di ${weekday}`,
    noReports: "nessun report ancora da quando lo seguo",
    reportsLastDay: (count) => `${count} report nelle ultime 24h`,
    quietDays: (days) => `fermo da ${days} ${days === 1 ? "giorno" : "giorni"}`,
    next: "prossimo",
    unreportedCommits: (count) => `⚠️ ${count} commit senza report`,
    nothingNew: "nessuna novità",
    notReported: "non rilevata",
    usd: (value) => `${value.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`,
    spend: (dev, pm) => `Spesa ultimi 7 giorni: sviluppo ${dev}, PM ${pm}`,
  },

  limits: {
    windowName: (product, label) => `${product}, finestra ${label}`,
    atTime: (hhmm) => `alle ${hhmm}`,
    tomorrowAt: (hhmm) => `domani alle ${hhmm}`,
    dateAt: (date, hhmm) => `${date} alle ${hhmm}`,
    inRel: (when, rel) => `${when} (tra ${rel})`,
    now: "ora",
    reachedWhen: (name, when) => `⛔ ${name} ha raggiunto il limite. Si sblocca ${when}.`,
    reachedPlain: (name) => `⛔ ${name} ha raggiunto il limite.`,
    reachedUnknown: (name) => `⛔ ${name} ha raggiunto il limite. Non so quando si sblocca: ti avviso appena torna a funzionare.`,
    shouldBeBack: (name, when) => `✅ ${name} dovrebbe essere di nuovo disponibile (il limite scadeva ${when}).`,
    back: (name) => `✅ ${name} è di nuovo disponibile.`,
    windowReset: (name) => `✅ ${name} è di nuovo disponibile: la finestra si è azzerata.`,
    used: usedPhrase,
    warn: (name, percent, when) => `⚠️ ${name}: ${usedPhrase(percent)}.${when ? ` Si azzera ${when}.` : ""}`,
    summaryTitle: "Limiti abbonamenti",
    limitReached: "limite raggiunto",
    fiveHours: "5 ore",
    weekly: "settimana",
    hours: (n) => `${n} ore`,
  },

  spoken: {
    codeBlock: " Un dettaglio di codice è disponibile nel testo. ",
    pullRequest: (n) => `la pull request numero ${n}`,
    file: " un file",
    link: "un link",
    commit: "un commit",
    technicalRef: "un riferimento tecnico",
    rest: "Il resto lo trovi nel testo.",
  },

  pm: {
    capped: (cap) =>
      `Ho raggiunto il tetto di spesa del PM per questo mese (${cap.toFixed(2)} $), quindi non interrogo il modello. ` +
      "I report restano disponibili con `leftoff brief`. Puoi alzare il tetto in config.yaml (pm.budget.monthlyUsd).",
    budgetWarn: (spent, cap) => `ℹ️ Spesa del PM questo mese: ${spent.toFixed(2)} $ su ${cap.toFixed(2)} $ di tetto.`,
    refused: "Il modello ha rifiutato di rispondere a questa richiesta. Prova a riformularla.",
    empty: "Non sono riuscito a formulare una risposta. Riprova tra poco.",
    answerIn: "Italian",
  },

  tasks: {
    addedDecision: "Aggiunte al backlog dal PM",
    requestWhy: "Richiesta del proprietario",
  },

  hub: {
    restartScheduled: (count) => ` Ripartenza automatica programmata per ${count === 1 ? "l’agente fermato" : `${count} agenti fermati`}.`,
    resumeInstruction: (product) =>
      `[leftoff] Il limite di ${product} si è azzerato. Riprendi ora l’attività esattamente dal punto in cui ti eri fermato. Prima verifica lo stato corrente del progetto; poi continua e manda il normale report Leftoff.`,
    autoRestartDecision: "Ripartenza automatica dopo il reset del limite",
    restartUnreachable: (name) => `⚠️ ${name}: il limite si è azzerato, ma la sessione che si era fermata non è più raggiungibile. Non ho riavviato nessun'altra sessione al suo posto.`,
    restartAsked: (name, queued) => `▶️ ${name}: limite azzerato, ho chiesto di ripartire${queued ? "; messaggio in coda perché non è raggiungibile" : ""}.`,
    replyStatus: (who) => `Aggiornamento da ${who} (chiesto dal PM)`,
    replyInstruction: (who) => `Risposta di ${who} alla tua istruzione`,
    statusQuestion:
      "[leftoff] Il project manager chiede un aggiornamento. Appena puoi, scrivi un report Leftoff (leftoff report): cosa hai fatto, cosa stai facendo, se sei bloccato e che cosa ti serve. Se hai finito, dillo. Non cambiare il tuo piano per questo.",
    sayYesToSend: " Dimmi sì per inviarla, o dimmi cosa cambiare.",
    draftShownNote: (summary) => `[Bozza mostrata in chat, in attesa del sì: ${summary}]`,
    dropped: "👍 Annullata, non ho mandato niente.",
    modelDown: (waiting) => `Non riesco a rispondere ora: c'è un problema col modello. Riprovo più tardi.${waiting ? " La bozza che ti ho mostrato prima è ancora in attesa: «sì» la invia, «no» la annulla." : ""}`,
    projectGone: "Quel progetto non c'è più: non ho mandato niente.",
    capReached: (cap) => `Ho già mandato ${cap} istruzioni nelle ultime 24 ore, il limite che mi sono dato. Non mando altro: alza commands.maxPerDay se serve.`,
    instructionDecision: (agent, summary) => `Istruzione a ${agent}: ${summary}`,
    instructionWhy: (prompt) => `Approvata in chat e trasmessa dal PM. Testo inviato:\n${prompt}`,
    sendFailed: "Non sono riuscito a mandarla. La bozza è andata persa: dimmi di nuovo cosa vuoi.",
    noTranscriber: "Per ora capisco solo il testo: i vocali non sono attivi (manca la chiave del trascrittore).",
    voiceTooLong: (seconds, max) => `Il vocale è troppo lungo (${seconds} s, massimo ${max} s). Spezzalo o scrivimelo.`,
    heardNothing: "🎙️ Non ho sentito niente di chiaro. Riprova o scrivimelo.",
    notSure: (text) => `🎙️ Non sono sicuro di aver capito: «${text}». Riregistralo o scrivimelo.`,
    transcribeFailed: "Non sono riuscito a trascrivere il vocale. Riprova o scrivimelo.",
    whichProjectMute: "Quale progetto? Es. /mute clipforge 4 (ore)",
    muted: (project, until) => `🔕 ${project} silenziato fino a ${until}`,
    unmuted: (project) => `🔔 ${project ?? "Progetto"} di nuovo attivo.`,
    quietOn: (start, end) => `🌙 Quiet hours attive dalle ${start} alle ${end}. Disattiva con /quiet off.`,
    quietOff: "🔔 Quiet hours disattivate: gli aggiornamenti arrivano a qualsiasi ora. Attiva con /quiet on.",
    whichProjectResume: "Quale progetto? Usa /riparti <progetto> [agente].",
    whichAgentResume: (project, agents) => `Quale agente? Usa /riparti ${project} <${agents || "agente"}>.`,
    manualResumeInstruction:
      "[leftoff] Riprendi ora l’attività dal punto in cui ti eri fermato. Verifica prima lo stato corrente del progetto, poi continua e manda il normale report Leftoff.",
    manualResumeDecision: "Ripartenza manuale richiesta a",
    resumeAsked: (agent, project) => `▶️ ${agent} (${project}): ho chiesto di ripartire ora.`,
    resumeQueued: (agent, project) => `📥 ${agent} (${project}): messaggio di ripartenza in coda; non è raggiungibile ora.`,
    voiceUnavailable: "Le risposte vocali non sono disponibili (manca la chiave Deepgram).",
    voiceLabel: (mode) =>
      ({
        mirror: "automatico: ti rispondo a voce quando mi scrivi a voce",
        always: "sempre: ogni risposta e lo stand-up hanno anche la voce",
        never: "mai: solo testo",
      })[mode],
    voiceStatus: (label) => `🔊 Voce: ${label}.\nCambia con /voce on, /voce off o /voce auto.`,
    languageNow: (name, options) => `🌐 Lingua: ${name}. Cambia con /lingua ${options}.`,
    languageUnknown: (options) => `Non conosco quella lingua. Scegli tra: ${options}.`,
    alertsStatus: (level) => ({ critical: '🔔 Avvisi: solo critici — un agente bloccato o che ha bisogno di te, un limite raggiunto, la risposta a ciò che hai chiesto. Il resto è nella dashboard. Cambia con /avvisi normali o /avvisi tutti.', normal: '🔔 Avvisi: normali — i critici più il lavoro finito e gli avvisi sui limiti. Cambia con /avvisi critici o /avvisi tutti.', all: '🔔 Avvisi: tutti — ogni cosa, anche i commit senza report. Cambia con /avvisi critici o /avvisi normali.' })[level],
    alertsUnknown: 'Scegli tra: critici, normali, tutti.',
    help: "Scrivimi normalmente: «a che punto siamo?». Comandi: /overview, /ufficio [progetto], /riparti <progetto> [agente], /quiet on|off, /voce on|off|auto, /lingua <codice>, /avvisi critici|normali|tutti, /mute <progetto> [ore], /unmute <progetto>.",
  },
};
