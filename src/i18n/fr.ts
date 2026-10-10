import type { Messages } from "./types.ts";

const INBOX_REASON: Record<string, string> = {
  "the Paseo session is closed": "la session Paseo est fermée",
  "agent unknown": "je ne le connais pas",
  "not run by Paseo": "n'est pas géré par Paseo",
};

export const fr: Messages = {
  name: "Français",

  report: {
    and: "et",
    taskFallback: "sa tâche",
    finished: (who, what) => `✅ ${who} a terminé : ${what}.`,
    decisions: (items) => `Décisions : ${items}`,
    findings: (items) => `Constats : ${items}`,
    next: (items) => `Ensuite : ${items}`,
    nowIdle: "Il est à l'arrêt. Que doit-il faire ?",
    blocked: (who, reason) => `⛔ ${who} est bloqué : ${reason}.`,
    noReason: "motif non indiqué",
    recommends: (option) => `Recommande : ${option}`,
    doneSoFar: (items) => `Fait jusqu'ici : ${items}`,
    needsYou: (who) => `❓ ${who} a besoin de toi.`,
    nextStep: (items) => `Prochaine étape : ${items}`,
    done: (items) => `Fait : ${items}`,
    idle: (who, lastWork) => `💤 ${who} est à l'arrêt.${lastWork ? ` Dernier travail : ${lastWork}.` : ""}`,
    suggests: (items) => `Propositions : ${items}`,
    whatShouldItDo: "Que doit-il faire ?",
  },

  delivery: {
    reason: (english) => INBOX_REASON[english] ?? "n'est pas joignable pour le moment",
    draftBusy: "🟢 Il travaille : je le lui donne à la fin de son tour en cours, sans l'interrompre.",
    draftIdle: "💤 Il est à l'arrêt : ce message le relancera.",
    sentBusy: "Il travaille : je le lui donne à la fin de son tour en cours, sans l'interrompre.",
    sentIdle: "Il était à l'arrêt : il redémarre maintenant.",
    delivered: (agent, project, live) => (live ? `📨 Remis à ${agent} (${project}) : il avait fini son tour.` : `📨 ${agent} (${project}) n'est plus dans Paseo : le message est dans sa boîte, pour sa prochaine session.`),
    unreachable: (why) => `📥 Pas joignable pour le moment (${why}) : le message attendra dans sa boîte jusqu'à sa prochaine session.`,
    draftHeader: (agent, project) => `📨 Brouillon pour ${agent} — ${project}`,
    approveHint: (ttl) => `Réponds « oui » pour l'envoyer, « non » pour l'annuler, ou dis-moi quoi changer. (Valable ${ttl >= 60 ? `${Math.round(ttl / 60)} h` : `${ttl} min`}.)`,
    sent: (agent, project) => `Envoyé à ${agent} (${project}).`,
    willTell: "Je te préviens quand il répond.",
    choiceSend: "✅ Oui, envoyer",
    choiceDrop: "✖ Non",
    yesWord: "oui",
    noWord: "non",
  },

  handoff: {
    header: (from, to, project) => `🤝 Passage de relais — ${from} → ${to} (${project})`,
    instruction: (p) =>
      [
        `Demande de ton coéquipier ${p.from}${p.role ? ` (${p.role})` : ""}, transmise par le chef de projet avec l'accord du responsable :`,
        "",
        `« ${p.ask} »`,
        "",
        `Contexte : son rapport ${p.report}${p.branch ? `, branche ${p.branch}` : ""}${p.commits.length ? `, commits ${p.commits.join(", ")}` : ""}.`,
        "Si c'est à toi de le faire, fais-le ; sinon, ou s'il te faut d'abord quelque chose, dis-le dans ton rapport.",
        `Quand tu as fini, fais ton rapport comme d'habitude. Si ${p.from} doit savoir ou faire quelque chose, ajoute --handoff "${p.fromId}: <quoi>".`,
      ].join("\n"),
    unknownTarget: (from, to, ask, team) => `🤝 ${from} a besoin de « ${ask} » de la part de « ${to} », mais aucun agent du projet ne correspond. Équipe : ${team}. Dis-moi qui doit le faire, ou donne un rôle aux agents (leftoff agents role).`,
    decision: (from, to, ask) => `Passage de relais approuvé : ${from} → ${to} : ${ask}`,
    reply: (who, from) => `Réponse de ${who} à la demande de ${from}`,
    expired: (from, to) => `⌛ Le passage de relais ${from} → ${to} a expiré sans réponse. Demande-moi de le renvoyer s'il compte encore.`,
  },

  modes: {
    name: { control: "contrôlé", autonomous: "autonome" },
    changed: (project, mode) => (mode === "autonomous" ? `🤖 ${project} : mode autonome. Ce que tu demandes, et les transmissions entre coéquipiers, partent sans attendre ton oui ; je te préviens à chaque fois. Les actions destructrices ou irréversibles, et mes propres idées, t'attendent encore.` : `✋ ${project} : mode contrôlé. Chaque instruction à un agent attend ton oui.`),
    already: (project, mode) => `${project} est déjà en mode ${({ control: "contrôlé", autonomous: "autonome" })[mode]}.`,
    confirm: (project) => `J'active le mode autonome pour ${project} ? Tes instructions et les transmissions entre coéquipiers partiront sans te demander d'abord.`,
    risky: `⚠️ Mode autonome, mais celle-ci a besoin de ton oui : elle semble destructrice ou irréversible.`,
    initiative: `Mode autonome, mais c'est mon idée, pas ta demande : elle a besoin de ton oui.`,
    handoffForwarded: (from, to, project, ask) => `🤝 Transmis automatiquement (mode autonome) : ${from} → ${to} (${project})\n«${ask}»`,
    autoWhy: `mode autonome : envoyée sans demander de oui`,
    decision: (mode) => `Mode du chef de projet : ${({ control: "contrôlé", autonomous: "autonome" })[mode]}`,
  },

  newAgent: {
    firstPrompt: (p) =>
      [
        `Tu es ${p.name}, un nouvel agent de l'équipe ${p.project}, créé par le responsable depuis Leftoff.`,
        ...(p.role ? [`Ton rôle : ${p.role}.`] : []),
        "",
        ...(p.task ? [`Ta première tâche :`, "", p.task] : [`Pas encore de tâche : découvre le projet (README, rapports récents dans .leftoff/), puis fais ton rapport avec le statut idle et attends des instructions.`]),
        "",
        `Tes coéquipiers et la façon de faire ton rapport sont dans le briefing reçu en début de session. Quand tu as fini, fais ton rapport comme d'habitude.`,
      ].join("\n"),
  },

  office: {
    title: (project) => `🏢 ${project} — le bureau`,
    states: { working: "au travail", blocked: "bloqué", needs: "a besoin de toi", awaiting: "attend une réponse", done: "a fini", idle: "inactif" },
    handoff: (from, to, ask) => `🤝 ${from} → ${to} : ${ask}`,
    whichProject: "Quel projet ? Écris /bureau <projet>, ou envoie-le dans le sujet du projet.",
    noAgents: (project) => `Pas encore d'agents dans ${project} : ils apparaissent après leur premier rapport.`,
  },

  unreported: {
    head: (count, branch) => `⚠️ ${count} commit${count === 1 ? "" : "s"}${branch ? ` sur ${branch}` : ""} sans rapport.`,
    andMore: (count) => `…et ${count} de plus`,
    askSummary: "Veux-tu que je demande un résumé à l'agent ?",
  },

  standup: {
    title: (weekday) => `📋 Point du ${weekday}`,
    noReports: "aucun rapport depuis que je le suis",
    reportsLastDay: (count) => `${count} rapport${count === 1 ? "" : "s"} ces dernières 24 h`,
    quietDays: (days) => `calme depuis ${days} jour${days === 1 ? "" : "s"}`,
    next: "ensuite",
    unreportedCommits: (count) => `⚠️ ${count} commit${count === 1 ? "" : "s"} sans rapport`,
    nothingNew: "rien de nouveau",
    notReported: "non relevée",
    usd: (value) => `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`,
    spend: (dev, pm) => `Dépenses des 7 derniers jours : développement ${dev}, PM ${pm}`,
  },

  limits: {
    windowName: (product, label) => `${product}, fenêtre ${label}`,
    atTime: (hhmm) => `à ${hhmm}`,
    tomorrowAt: (hhmm) => `demain à ${hhmm}`,
    dateAt: (date, hhmm) => `${date} à ${hhmm}`,
    inRel: (when, rel) => `${when} (dans ${rel})`,
    now: "maintenant",
    reachedWhen: (name, when) => `⛔ ${name} a atteint sa limite. Elle se débloque ${when}.`,
    reachedPlain: (name) => `⛔ ${name} a atteint sa limite.`,
    reachedUnknown: (name) => `⛔ ${name} a atteint sa limite. Je ne sais pas quand elle se débloque : je te préviens dès que ça refonctionne.`,
    shouldBeBack: (name, when) => `✅ ${name} devrait être de nouveau disponible (la limite expirait ${when}).`,
    back: (name) => `✅ ${name} est de nouveau disponible.`,
    windowReset: (name) => `✅ ${name} est de nouveau disponible : la fenêtre a été réinitialisée.`,
    used: (percent) => `${Math.round(percent)} % utilisé`,
    warn: (name, percent, when) => `⚠️ ${name} : ${Math.round(percent)} % utilisé.${when ? ` Réinitialisation ${when}.` : ""}`,
    summaryTitle: "Limites des abonnements",
    limitReached: "limite atteinte",
    fiveHours: "5 heures",
    weekly: "hebdomadaire",
    hours: (n) => `${n} h`,
  },

  spoken: {
    codeBlock: " Un détail de code est disponible dans le texte. ",
    pullRequest: (n) => `la pull request numéro ${n}`,
    file: " un fichier",
    link: "un lien",
    commit: "un commit",
    technicalRef: "une référence technique",
    rest: "Le reste est dans le texte.",
  },

  pm: {
    capped: (cap) =>
      `Le PM a atteint son plafond de dépenses pour ce mois (${cap.toFixed(2)} $), je n'interroge donc pas le modèle. ` +
      "Les rapports restent disponibles avec `leftoff brief`. Tu peux relever le plafond dans config.yaml (pm.budget.monthlyUsd).",
    budgetWarn: (spent, cap) => `ℹ️ Dépenses du PM ce mois-ci : ${spent.toFixed(2)} $ sur un plafond de ${cap.toFixed(2)} $.`,
    refused: "Le modèle a refusé cette demande. Essaie de la reformuler.",
    empty: "Je n'ai pas réussi à formuler une réponse. Réessaie dans un instant.",
    answerIn: "French",
  },

  tasks: {
    addedDecision: "Ajoutées au backlog par le PM",
    requestWhy: "Demande du propriétaire",
  },

  hub: {
    restartScheduled: (count) => ` Redémarrage automatique programmé pour ${count === 1 ? "l'agent arrêté" : `${count} agents arrêtés`}.`,
    resumeInstruction: (product) =>
      `[leftoff] La limite de ${product} a été réinitialisée. Reprends maintenant exactement là où tu t'étais arrêté. Vérifie d'abord l'état actuel du projet, puis continue et envoie le rapport Leftoff habituel.`,
    autoRestartDecision: "Redémarrage automatique après la réinitialisation de la limite",
    restartUnreachable: (name) => `⚠️ ${name} : la limite a été réinitialisée, mais la session qui s'était arrêtée n'est plus joignable. Je n'ai redémarré aucune autre session à sa place.`,
    restartAsked: (name, queued) => `▶️ ${name} : limite réinitialisée ; j'ai demandé de reprendre${queued ? " ; en file d'attente car injoignable" : ""}.`,
    replyStatus: (who) => `Mise à jour de ${who} (demandée par le PM)`,
    replyInstruction: (who) => `Réponse de ${who} à ton instruction`,
    sayYesToSend: " Dis « oui » pour l'envoyer, ou dis-moi quoi changer.",
    draftShownNote: (summary) => `[Brouillon montré dans le chat, en attente d'un oui : ${summary}]`,
    statusQuestion:
      "[leftoff] Le chef de projet demande une mise à jour. Dès que tu peux, écris un rapport Leftoff (leftoff report) : ce que tu as fait, ce que tu fais, si tu es bloqué et ce dont tu as besoin. Si tu as terminé, dis-le. Ne change pas ton plan pour cela.",
    dropped: "👍 Annulé, rien n'a été envoyé.",
    modelDown: (waiting) => `Je ne peux pas répondre maintenant : le modèle est indisponible.${waiting ? " Le brouillon montré plus tôt attend toujours : « oui » l'envoie, « non » l'annule." : ""}`,
    projectGone: "Ce projet n'existe plus : rien n'a été envoyé.",
    capReached: (cap) => `J'ai déjà envoyé ${cap} instructions ces dernières 24 heures, mon propre plafond. Rien n'est envoyé ; relève commands.maxPerDay si besoin.`,
    instructionDecision: (agent, summary) => `Instruction à ${agent} : ${summary}`,
    instructionWhy: (prompt) => `Approuvée dans le chat et transmise par le PM. Texte envoyé :\n${prompt}`,
    sendFailed: "Je n'ai pas pu l'envoyer. Le brouillon est perdu : dis-moi à nouveau ce que tu veux.",
    noTranscriber: "Je ne comprends que le texte pour l'instant : les messages vocaux ne sont pas activés (pas de clé de transcription).",
    voiceTooLong: (seconds, max) => `Ce message vocal est trop long (${seconds} s, maximum ${max} s). Découpe-le ou écris-le.`,
    heardNothing: "🎙️ Je n'ai rien compris de clair. Réessaie ou écris-le.",
    notSure: (text) => `🎙️ Je ne suis pas sûr d'avoir bien compris : « ${text} ». Réenregistre-le ou écris-le.`,
    transcribeFailed: "Je n'ai pas pu transcrire ce message vocal. Réessaie ou écris-le.",
    whichProjectMute: "Quel projet ? Ex. /mute clipforge 4 (heures)",
    muted: (project, until) => `🔕 ${project} en sourdine jusqu'à ${until}`,
    unmuted: (project) => `🔔 ${project ?? "Projet"} de nouveau actif.`,
    quietOn: (start, end) => `🌙 Les heures calmes sont actives de ${start} à ${end}. Désactive avec /quiet off.`,
    quietOff: "🔔 Les heures calmes sont désactivées : les mises à jour arrivent à toute heure. Active avec /quiet on.",
    whichProjectResume: "Quel projet ? Utilise /resume <projet> [agent].",
    whichAgentResume: (project, agents) => `Quel agent ? Utilise /resume ${project} <${agents || "agent"}>.`,
    manualResumeInstruction:
      "[leftoff] Reprends maintenant là où tu t'étais arrêté. Vérifie d'abord l'état actuel du projet, puis continue et envoie le rapport Leftoff habituel.",
    manualResumeDecision: "Redémarrage manuel demandé à",
    resumeAsked: (agent, project) => `▶️ ${agent} (${project}) : j'ai demandé de reprendre maintenant.`,
    resumeQueued: (agent, project) => `📥 ${agent} (${project}) : message de reprise en file d'attente ; injoignable pour le moment.`,
    voiceUnavailable: "Les réponses vocales ne sont pas disponibles (pas de clé Deepgram).",
    voiceLabel: (mode) =>
      ({
        mirror: "auto : je réponds à voix haute quand tu m'écris à voix haute",
        always: "toujours : chaque réponse et le point du jour ont aussi une voix",
        never: "jamais : texte seulement",
      })[mode],
    voiceStatus: (label) => `🔊 Voix : ${label}.\nChange avec /voix on, /voix off ou /voix auto.`,
    languageNow: (name, options) => `🌐 Langue : ${name}. Change avec /langue ${options}.`,
    languageUnknown: (options) => `Je ne connais pas cette langue. Choisis parmi : ${options}.`,
    alertsStatus: (level) => ({ critical: '🔔 Alertes : critiques seulement — un agent bloqué ou qui a besoin de toi, une limite atteinte, la réponse à ce que tu as demandé. Le reste est dans le tableau de bord. Change avec /alerts normal ou /alerts all.', normal: '🔔 Alertes : normales — les critiques plus le travail terminé et les avertissements de limite. Change avec /alerts critical ou /alerts all.', all: '🔔 Alertes : toutes — tout, y compris les commits sans rapport. Change avec /alerts critical ou /alerts normal.' })[level],
    alertsUnknown: 'Choisis parmi : critical, normal, all.',
    help: "Écris-moi simplement : « où en sommes-nous ? ». Commandes : /overview, /bureau [projet], /resume <projet> [agent], /quiet on|off, /voice on|off|auto, /language <code>, /alerts critical|normal|all, /mute <projet> [heures], /unmute <projet>.",
  },
};
