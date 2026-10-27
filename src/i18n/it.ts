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
    unreachable: (why) => `📥 Non è raggiungibile ora (${why}): resta nella sua inbox e glielo consegno appena la sua sessione in Paseo è di nuovo attiva, oppure lo legge alla prossima sessione.`,
    draftHeader: (agent, project) => `📨 Bozza per ${agent} — ${project}`,
    approveHint: (ttl) => `Rispondi «sì» per inviarla, «no» per annullarla, o dimmi cosa cambiare. (Valida ${ttl >= 60 ? `${Math.round(ttl / 60)} ore` : `${ttl} minuti`}.)`,
    sent: (agent, project) => `Inviato a ${agent} (${project}).`,
    waiting: (agent, project) => `Non ancora inviato: in attesa per ${agent} (${project}).`,
    willTell: "Ti avviso quando risponde.",
    choiceSend: "✅ Sì, invia",
    choiceDrop: "✖ No",
    yesWord: "sì",
    noWord: "no",
  },

  loops: {
    question: (p) => `🔁 ${p.agent} (${p.project}) ti ha fatto la stessa domanda ${p.count} volte da ${p.since}: «${p.question}». Rispondigli una volta per tutte; se continua, ti propongo di fermarlo.`,
    review: (p) => `🔁 ${p.project}: la PR ${p.pr} è passata ${p.count} volte tra ${p.who} da ${p.since}, revisioni e correzioni senza fine. Se continua, ti propongo di fermare il giro.`,
    waiting: (p) => `⏳ ${p.agent} (${p.project}) aspetta una risposta da ${p.target} dalle ${p.since}, e non è arrivata. Se continua, ti propongo di sbloccarlo.`,
    ci: (p) => `💸 ${p.project}: ${p.runs} esecuzioni di CI da ${p.since}${p.branch ? `, quasi tutte su ${p.branch}` : ""}. I push sono troppi; se continua, ti propongo di fermarli.`,
    brakeAsk: "fermati sul ciclo e fai il report",
    brakePrompt: (evidence) => `[leftoff · PM] Il responsabile ha visto che stai girando in tondo:\n${evidence}\nFermati su questo: niente nuovi push né nuove richieste a riguardo. Fai un report di dove sei e di cosa ti serve per uscirne, e aspetta la sua risposta.`,
    braked: (p) => `🛑 Freno (${p.project}): continua.\n${p.evidence}\n${p.agent ? `Ti mostro una bozza per ${p.agent}: parte solo con il tuo «sì».` : "Non so chi fermare: dimmelo tu."} Se va avanti ancora, metto in pausa i messaggi automatici.`,
    paused: (p) => `⏸️ Pausa (${p.project}): il ciclo non si è fermato.\n${p.evidence}\n${p.agents ? `Non passo più in automatico messaggi da e per ${p.agents}: li vedi tu con Sì/No. Nessuna sessione è stata toccata. Riprendi quando vuoi.` : "Non so chi mettere in pausa: dimmelo tu."}`,
    resumeButton: (agent) => `▶️ Riprendi ${agent}`,
    resumed: (agents, project) => `▶️ ${agents} (${project}) di nuovo in automatico.`,
    heldWhy: "⏸️ In pausa per un ciclo: in automatico non passa, decidi tu.",
    pausedList: (list) => `In pausa: ${list}. /riprendi <progetto> [agente] per riprendere.`,
    nonePaused: "Nessun agente in pausa.",
  },
  stuck: {
    alert: (p) => `⏸️ ${p.agent} (${p.project}) si è fermato alle ${p.at} senza report${p.error ? `, per un errore: ${p.error}` : ""}${p.closed ? "; la sua sessione Paseo è chiusa" : ""}. Stava facendo: «${p.request}».${p.step ? ` Ultimo passo: «${p.step}».` : ""} Probabilmente aspetta qualcosa da te: guardalo in Paseo.`,
  },
  ops: {
    forwarded: (name, queued) => `📨 Passato a ${name}, il PM operativo di questo progetto: ${queued ? "lo legge appena finisce il turno" : "ti risponde qui"}.`,
    fallback: (name) => `⚠️ ${name}, il PM operativo, non è raggiungibile adesso: rispondo io.`,
    ownerSays: (p) => `[leftoff · PM operativo] Il responsabile scrive nel thread di ${p.project}: «${p.text}»\nRispondigli con: leftoff pm say --project ${p.id} "…"\nPer chiedere qualcosa a un agente del progetto: leftoff pm ask --project ${p.id} --to <agente> "…" (aspetta il sì del responsabile, salvo progetto autonomo).\nIn un progetto autonomo le tue leftoff pm ask partono subito, senza passare dal responsabile (se l'agente ha la sessione chiusa aspettano nella sua inbox e il responsabile viene avvisato); in un progetto in controllo il responsabile le vede con Sì/No.\nQuello che il responsabile deve copiare o scrivere (un comando, una chiave, un percorso) mettilo da solo in un blocco di codice tra tre apici inversi, intero, esattamente come va incollato: il pannello ci mette il pulsante Copia.\nLo stato del progetto: cd ${p.root} && leftoff brief`,
    feed: (lines) => `[leftoff · PM operativo] Novità nei progetti che segui:\n${lines}\nSe serve, scrivi al responsabile con leftoff pm say o chiedi a un agente con leftoff pm ask. Se non serve nulla, non rispondere.`,
    says: (name, text) => `🧭 ${name} (PM operativo): ${text}`,
    delegated: (project, name) => `🧭 ${project} ora è seguito da ${name}, il PM operativo: i tuoi messaggi nel suo thread vanno a lui.`,
    undelegated: (project) => `🧭 ${project} torna al PM.`,
    status: (name, projects) => name ? `🧭 PM operativo: ${name}. Progetti che segue: ${projects || "nessuno"}. /delega <progetto> per affidargliene uno, /delega <progetto> off per riprenderlo.` : "Nessun PM operativo: sceglilo nel pannello (⚙ del PM).",
    noOps: "Nessun PM operativo: sceglilo nel pannello (⚙ del PM).",
    usage: "Quale progetto? /delega <progetto>, oppure /delega <progetto> off.",
    decision: (project, name, on) => on ? `${project} affidato a ${name}, il PM operativo` : `${project} ripreso dal PM`,
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
        `Quando hai finito, fai il report come sempre: la tua risposta arriva a ${p.from} da sola. Usa --handoff solo per chiedere nuovo lavoro a un collega, mai per confermare, ringraziare o dire che è fatto.`,
      ].join("\n"),
    unknownTarget: (from, to, ask, team) => `🤝 ${from} chiede «${ask}» a “${to}”, ma nessun agente del progetto corrisponde. Squadra: ${team}. Dimmi chi deve farlo, oppure assegna un ruolo agli agenti (leftoff agents role).`,
    decision: (from, to, ask) => `Passaggio di consegne approvato: ${from} → ${to}: ${ask}`,
    answer: (who, report) => `[leftoff] Risposta di ${who} alla tua richiesta, inoltrata dal project manager:\n\n${report}\n\nÈ un'informazione: non serve rispondere. Usa --handoff solo se ti serve nuovo lavoro da un collega.`,
    reply: (who, from) => `Risposta di ${who} alla richiesta di ${from}`,
    expired: (from, to) => `⌛ Il passaggio di consegne ${from} → ${to} è scaduto senza risposta. Chiedimi di rimandarlo, se serve ancora.`,
    waitsClosed: (to, project) => `⚠️ ${to} (${project}) ha la sessione Paseo chiusa: le richieste per lui aspettano nella sua inbox e nessuno le sta facendo. Riaprila in Paseo e le riceve subito.`,
  },

  modes: {
    name: { control: "controllata", autonomous: "autonoma" },
    changed: (project, mode) => (mode === "autonomous" ? `🤖 ${project}: modalità autonoma. Quello che mi chiedi, e gli handoff tra colleghi, partono senza aspettare il tuo sì; ti avviso ogni volta. Le azioni distruttive o irreversibili, e le mie iniziative, aspettano ancora te.` : `✋ ${project}: modalità controllata. Ogni istruzione a un agente aspetta il tuo sì.`),
    already: (project, mode) => `${project} è già in modalità ${({ control: "controllata", autonomous: "autonoma" })[mode]}.`,
    confirm: (project) => `Attivo la modalità autonoma per ${project}? Le tue istruzioni e gli handoff tra colleghi partiranno senza chiederti prima.`,
    risky: `⚠️ Modalità autonoma, ma questa serve il tuo sì: sembra un'azione distruttiva o irreversibile.`,
    braked: (n) => `⚠️ Modalità autonoma, ma nell'ultima ora sono già passati da soli ${n} passaggi di consegne: questo aspetta il tuo sì, nel caso gli agenti stiano girando in tondo.`,
    initiative: `Modalità autonoma, ma è una mia idea, non una tua richiesta: serve il tuo sì.`,
    handoffForwarded: (from, to, project, ask) => `🤝 Passato in automatico (modalità autonoma): ${from} → ${to} (${project})\n«${ask}»`,
    autoWhy: `modalità autonoma: inviata senza chiedere il sì`,
    decision: (mode) => `Modalità del project manager: ${({ control: "controllata", autonomous: "autonoma" })[mode]}`,
  },

  plan: {
    request: (p) =>
      [
        `Il responsabile vuole pianificare prima di partire con lo sviluppo: «${p.goal}» (${p.project}). Non iniziare ancora a implementare.`,
        `Proponi la tua parte del piano${p.role ? " come " + p.role : ""}: solo i passi principali, di solito da 3 a 10 attività. Per ciascuna esegui:`,
        `  leftoff plan add --agent ${p.agent} --plan ${p.planId} --phase "1 · <fase>" --title "<cosa si fa>" --description "<obiettivo, contesto, cosa resta fuori>" --criteria "<come si sa che è fatta>" --depends <TASK-id da cui dipende>`,
        `Guarda le attività dei colleghi con \`leftoff plan show\` e collegale con --depends dove ti serve prima il loro lavoro. Numera le fasi così si ordinano (1 · …, 2 · …).`,
        `Poi fai il report come sempre. Il lavoro parte quando il responsabile approva il piano.`,
      ].join("\n"),
    ready: (goal, project, tasks) => `📋 Piano per «${goal}» (${project}): tutti gli agenti hanno mandato la loro parte, ${tasks} attività. Scrivimi «prepara il piano» e lo consolido per la tua approvazione.`,
    partial: (goal, project, tasks, missing) => `📋 Piano per «${goal}» (${project}): finora ${tasks} attività; mancano ancora: ${missing}. Posso consolidare con quello che è arrivato.`,
    none: (goal, project, missing) => `📋 Piano per «${goal}» (${project}): nessun agente ha ancora mandato la sua parte (chiesto a: ${missing}).`,
    shownHeader: (goal, project) => `📋 Piano per «${goal}» (${project}) — da approvare`,
    after: (ids) => `dopo ${ids}`,
    approveHint: (ttlMinutes) => `Rispondi «sì» per approvarlo e far partire lo sviluppo, «no» per farlo rivedere. (Valido ${Math.round(ttlMinutes / 60)} h.)`,
    approved: (goal, project, tasks) => `✅ Piano approvato: «${goal}» (${project}), ${tasks} attività. Ogni agente ha ricevuto le sue, in ordine.`,
    autoApproved: (goal, project, tasks) => `✅ Piano partito da solo (progetto autonomo): «${goal}» (${project}), ${tasks} attività. Ogni agente ha ricevuto le sue.`,
    lateYes: "Il tempo per confermare era scaduto, ma il piano è lo stesso che hai visto: lo faccio partire.",
    revise: `Piano non approvato: dimmi cosa cambiare.`,
    start: (p) =>
      [
        `Il piano «${p.goal}» è approvato. Le tue attività, in ordine:`,
        `${p.tasks}`,
        `Comincia da quelle con le dipendenze completate. Quando ne inizi o ne finisci una: leftoff plan set <TASK-id> "In Progress" (oppure "Done") --agent ${p.agent}. Fai il report come sempre.`,
        "Fai commit per unità coerenti e spingi quando un pezzo è pronto, non dopo ogni commit: ogni push lancia la CI, che si paga.",
      ].join("\n"),
    decision: (goal, tasks, phases) => `Piano approvato: «${goal}» (${tasks} attività in ${phases} fasi)`,
  },

  newProject: {
    draft: (name, folder) => `🆕 Nuovo progetto «${name}»\nCreo la cartella ${folder}, un repository git e il progetto Leftoff, e lo registro in Paseo.\nRispondi «sì» per crearlo, «no» per lasciar perdere.`,
    paseoDown: "Paseo non risponde ora: il progetto verrà creato e il passo Paseo aspetta un nuovo tentativo.",
    dropped: "Lasciato perdere. Non è stato creato niente.",
    creating: (name) => `⏳ Creo «${name}»…`,
    done: (name) => `✅ Progetto «${name}» creato.`,
    failed: (name, step, reason) => `⚠️ «${name}» è stato fatto fino al passo «${step}»: ${reason}`,
    steps: { folder: "cartella", repository: "repository git", leftoff: "progetto Leftoff", registry: "registro", paseo: "Paseo" },
    buttons: { openPanel: "Apri il pannello", addAgent: "Aggiungi un agente", retry: "Riprova", leave: "Lascia com'è" },
    invalid: { empty: "Dai un nome al progetto.", tooLong: (max) => `Il nome è troppo lungo (al massimo ${max} caratteri).`, badChars: "Il nome ha caratteri che una cartella non può avere.", reserved: "Quel nome è riservato: scegline un altro.", noId: "Da questo nome non ricavo una cartella: usa lettere latine o numeri." },
    exists: (kind) => (kind === "folder" ? "Esiste già una cartella con questo nome." : kind === "paseo" ? "Paseo ha già un progetto con questo nome." : "Esiste già un progetto con questo nome."),
    usage: "Dimmi il nome: /nuovoprogetto <nome>",
    busy: "In questa conversazione aspetta già un tuo sì: decidi prima quello, poi richiedi il progetto.",
  },

  activity: {
    instruction: (agent, summary) => `📤 Istruzione a ${agent}: «${summary}»`,
    planAsked: (agent, goal) => `🗺️ Chiesta a ${agent} la sua parte del piano: «${goal}»`,
    questionAsked: (agent, question) => `❓ Chiesto a ${agent}, per il responsabile: «${question}»`,
    statusAsked: (agent, queued) => (queued ? `❔ Chiesto lo stato a ${agent}: lo legge a fine turno.` : `❔ Chiesto lo stato a ${agent}.`),
    task: (id, title, status) => `📋 ${id} ${status === "Done" ? "completata" : "in corso"}: ${title}`,
    digest: (count, project, lines) =>
      [
        `🗂️ ${count} avvisi${project ? ` su ${project}` : ""}, raggruppati per non scriverti troppo spesso:`,
        ...lines.map((l) => `• ${l}`),
        ...(count > lines.length ? [`… e altri ${count - lines.length}.`] : []),
        "I dettagli sono nel pannello.",
      ].join("\n"),
  },

  addAgent: {
    usage: "Quale progetto? Scrivi /nuovoagente <progetto>, o mandalo nel topic del progetto.",
    role: (project) => `👤 Un nuovo agente per «${project}». Che ruolo ha? Toccane uno, o scrivilo.`,
    presets: [{ label: "Backend", name: "Backend", role: "Architettura e backend" }, { label: "Frontend e UX", name: "Frontend", role: "Frontend, UX e usabilità" }, { label: "Test e revisione", name: "Test e revisione", role: "Test e code review" }, { label: "Documentazione", name: "Documentazione", role: "Documentazione e testi" }],
    name: (proposal) => (proposal ? `Come si chiama? Tocca «${proposal}», o scrivine un altro.` : "Come si chiama? Scrivilo."),
    badName: "Il nome deve avere lettere o cifre, al massimo 60 caratteri. Scrivine un altro.",
    program: "Con quale programma lavora?",
    unknownProgram: "Tocca uno dei programmi qui sopra.",
    noPrograms: "Paseo non risponde, o non ha programmi da offrire: l'agente si potrà aggiungere dal pannello quando risponde.",
    summary: (name, role, project, program) => `👤 Nuovo agente «${name}»${role ? ` (${role})` : ""} in «${project}», con ${program}.\nRispondi «sì» per aggiungerlo, «no» per lasciar perdere.`,
    adding: (name) => `⏳ Aggiungo «${name}»…`,
    done: (name, project) => `✅ «${name}» è entrato in «${project}». Modello, livello di ragionamento e primo compito si impostano dal pannello.`,
    failed: (reason) => `⚠️ L'agente non è stato aggiunto: ${reason}`,
    dropped: "Lasciato perdere. Non è stato aggiunto nessun agente.",
    buttons: { use: (name) => `Usa «${name}»`, cancel: "✖ Annulla", yes: "✅ Sì, aggiungilo" },
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
    replyQuestion: (who) => `Risposta di ${who} alla domanda del PM`,
    replyStatus: (who) => `Aggiornamento da ${who} (chiesto dal PM)`,
    replyInstruction: (who) => `Risposta di ${who} alla tua istruzione`,
    teamQuestion: (question) => `[leftoff] Il project manager ti chiede, per il responsabile: «${question}»\nRispondi nel tuo prossimo report Leftoff (leftoff report: --found per i fatti, --decided per le scelte, --done per ciò che hai verificato), con quello che sai e che puoi leggere. È una domanda: non cambiare codice, file o il tuo piano per questo.`,
    statusQuestion:
      "[leftoff] Il project manager chiede un aggiornamento. Appena puoi, scrivi un report Leftoff (leftoff report): cosa hai fatto, cosa stai facendo, se sei bloccato e che cosa ti serve. Se hai finito, dillo. Non cambiare il tuo piano per questo.",
    sayYesToSend: " Dimmi sì per inviarla, o dimmi cosa cambiare.",
    draftShownNote: (summary) => `[Bozza mostrata in chat, in attesa del sì: ${summary}]`,
    dropped: "👍 Annullata, non ho mandato niente.",
    optionAnswer: (q, o) => `Risposta del responsabile alla tua domanda «${q}»: «${o}». Procedi di conseguenza.`,
    optionAlreadySent: (a, o) => `Avevo già mandato a ${a} la tua scelta «${o}»: non la rimando.`,
    modelDown: (waiting) => `Non riesco a rispondere ora: c'è un problema col modello. Riprovo più tardi.${waiting ? " La bozza che ti ho mostrato prima è ancora in attesa: «sì» la invia, «no» la annulla." : ""}`,
    projectGone: "Quel progetto non c'è più: non ho mandato niente.",
    capReached: (cap, project) => `Ho già mandato ${cap} istruzioni per ${project} nelle ultime 24 ore, il limite per progetto. Non mando altro: alza commands.maxPerDay se serve.`,
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
    alertsStatus: (level) => ({ critical: '🔔 Avvisi: solo critici — un agente bloccato o che ha bisogno di te, un limite raggiunto, la risposta a ciò che hai chiesto. Il resto è nella dashboard. Cambia con /avvisi normali o /avvisi tutti.', normal: '🔔 Avvisi: normali — i critici più il lavoro finito e gli avvisi sui limiti. Cambia con /avvisi critici o /avvisi tutti.', all: '🔔 Avvisi: tutti — come i normali: i passaggi tra te, il PM e gli agenti restano nel registro attività del pannello. Cambia con /avvisi critici o /avvisi normali.' })[level],
    alertsUnknown: 'Scegli tra: critici, normali, tutti.',
    help: "Scrivimi normalmente: «a che punto siamo?». Comandi: /overview, /ufficio [progetto], /riparti <progetto> [agente], /quiet on|off, /voce on|off|auto, /lingua <codice>, /avvisi critici|normali|tutti, /mute <progetto> [ore], /unmute <progetto>, /nuovoprogetto <nome>, /nuovoagente [progetto], /delega <progetto> [off], /riprendi <progetto> [agente].",
  },
};
