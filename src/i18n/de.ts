import type { Messages } from "./types.ts";

const INBOX_REASON: Record<string, string> = {
  "the Paseo session is closed": "die Paseo-Sitzung ist geschlossen",
  "agent unknown": "ich kenne ihn nicht",
  "not run by Paseo": "wird nicht von Paseo verwaltet",
};

export const de: Messages = {
  name: "Deutsch",

  report: {
    and: "und",
    taskFallback: "seine Aufgabe",
    finished: (who, what) => `✅ ${who} ist fertig: ${what}.`,
    decisions: (items) => `Entscheidungen: ${items}`,
    findings: (items) => `Erkenntnisse: ${items}`,
    next: (items) => `Als Nächstes: ${items}`,
    nowIdle: "Er hat jetzt nichts zu tun. Was soll er machen?",
    blocked: (who, reason) => `⛔ ${who} ist blockiert: ${reason}.`,
    noReason: "kein Grund angegeben",
    recommends: (option) => `Empfiehlt: ${option}`,
    doneSoFar: (items) => `Bisher erledigt: ${items}`,
    needsYou: (who) => `❓ ${who} braucht dich.`,
    nextStep: (items) => `Nächster Schritt: ${items}`,
    done: (items) => `Erledigt: ${items}`,
    idle: (who, lastWork) => `💤 ${who} ruht.${lastWork ? ` Letzte Arbeit: ${lastWork}.` : ""}`,
    suggests: (items) => `Vorschläge: ${items}`,
    whatShouldItDo: "Was soll er machen?",
  },

  delivery: {
    reason: (english) => INBOX_REASON[english] ?? "gerade nicht erreichbar",
    draftBusy: "🟢 Arbeitet gerade: Er liest das sofort, ohne zu unterbrechen.",
    draftIdle: "💤 Ruht: Diese Nachricht startet ihn wieder.",
    sentBusy: "Er hat gearbeitet: Er liest es sofort.",
    sentIdle: "Er ruhte: Er startet jetzt wieder.",
    unreachable: (why) => `📥 Gerade nicht erreichbar (${why}): Die Nachricht bleibt im Posteingang, bis seine nächste Sitzung beginnt.`,
    draftHeader: (agent, project) => `📨 Entwurf für ${agent} — ${project}`,
    approveHint: (ttl) => `Antworte «ja» zum Senden, «nein» zum Verwerfen, oder sag mir, was ich ändern soll. (Gültig ${ttl >= 60 ? `${Math.round(ttl / 60)} Std.` : `${ttl} Min.`}.)`,
    sent: (agent, project) => `An ${agent} gesendet (${project}).`,
    willTell: "Ich sage dir Bescheid, wenn er antwortet.",
    choiceSend: "✅ Ja, senden",
    choiceDrop: "✖ Nein",
    yesWord: "ja",
    noWord: "nein",
  },

  handoff: {
    header: (from, to, project) => `🤝 Übergabe — ${from} → ${to} (${project})`,
    instruction: (p) =>
      [
        `Anfrage deines Teamkollegen ${p.from}${p.role ? ` (${p.role})` : ""}, vom Projektmanager mit Zustimmung des Verantwortlichen weitergegeben:`,
        "",
        `„${p.ask}“`,
        "",
        `Kontext: sein Bericht ${p.report}${p.branch ? `, Branch ${p.branch}` : ""}${p.commits.length ? `, Commits ${p.commits.join(", ")}` : ""}.`,
        "Wenn das deine Aufgabe ist, erledige sie; wenn nicht, oder wenn du zuerst etwas brauchst, schreib es in deinen Bericht.",
        `Wenn du fertig bist, berichte wie immer. Muss ${p.from} etwas wissen oder tun, füge --handoff "${p.fromId}: <was>" hinzu.`,
      ].join("\n"),
    unknownTarget: (from, to, ask, team) => `🤝 ${from} braucht „${ask}“ von „${to}“, aber kein Agent dieses Projekts passt. Team: ${team}. Sag mir, wer es machen soll, oder gib den Agenten eine Rolle (leftoff agents role).`,
    decision: (from, to, ask) => `Übergabe freigegeben: ${from} → ${to}: ${ask}`,
    reply: (who, from) => `Antwort von ${who} auf die Anfrage von ${from}`,
    expired: (from, to) => `⌛ Die Übergabe ${from} → ${to} ist unbeantwortet abgelaufen. Sag mir, wenn ich sie erneut senden soll.`,
  },

  office: {
    title: (project) => `🏢 ${project} — das Büro`,
    states: { working: "arbeitet", blocked: "blockiert", needs: "braucht dich", awaiting: "wartet auf Antwort", done: "fertig", idle: "untätig" },
    handoff: (from, to, ask) => `🤝 ${from} → ${to}: ${ask}`,
    whichProject: "Welches Projekt? Schreib /buero <Projekt>, oder sende es im Thema des Projekts.",
    noAgents: (project) => `Noch keine Agenten in ${project}: sie erscheinen nach ihrem ersten Bericht.`,
  },

  unreported: {
    head: (count, branch) => `⚠️ ${count} ${count === 1 ? "Commit" : "Commits"}${branch ? ` auf ${branch}` : ""} ohne Bericht.`,
    andMore: (count) => `…und ${count} weitere`,
    askSummary: "Soll ich den Agenten um eine Zusammenfassung bitten?",
  },

  standup: {
    title: (weekday) => `📋 Stand-up ${weekday}`,
    noReports: "noch kein Bericht, seit ich es verfolge",
    reportsLastDay: (count) => `${count} ${count === 1 ? "Bericht" : "Berichte"} in den letzten 24 Std.`,
    quietDays: (days) => `ruhig seit ${days} ${days === 1 ? "Tag" : "Tagen"}`,
    next: "als Nächstes",
    unreportedCommits: (count) => `⚠️ ${count} ${count === 1 ? "Commit" : "Commits"} ohne Bericht`,
    nothingNew: "nichts Neues",
    notReported: "nicht erfasst",
    usd: (value) => `${value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`,
    spend: (dev, pm) => `Ausgaben der letzten 7 Tage: Entwicklung ${dev}, PM ${pm}`,
  },

  limits: {
    windowName: (product, label) => `${product}, ${label}-Fenster`,
    atTime: (hhmm) => `um ${hhmm} Uhr`,
    tomorrowAt: (hhmm) => `morgen um ${hhmm} Uhr`,
    dateAt: (date, hhmm) => `${date} um ${hhmm} Uhr`,
    inRel: (when, rel) => `${when} (in ${rel})`,
    now: "jetzt",
    reachedWhen: (name, when) => `⛔ ${name} hat sein Limit erreicht. Es wird ${when} freigegeben.`,
    reachedPlain: (name) => `⛔ ${name} hat sein Limit erreicht.`,
    reachedUnknown: (name) => `⛔ ${name} hat sein Limit erreicht. Ich weiß nicht, wann es freigegeben wird; ich melde mich, sobald es wieder funktioniert.`,
    shouldBeBack: (name, when) => `✅ ${name} sollte wieder verfügbar sein (das Limit lief ${when} ab).`,
    back: (name) => `✅ ${name} ist wieder verfügbar.`,
    windowReset: (name) => `✅ ${name} ist wieder verfügbar: Das Fenster wurde zurückgesetzt.`,
    used: (percent) => `${Math.round(percent)} % verbraucht`,
    warn: (name, percent, when) => `⚠️ ${name}: ${Math.round(percent)} % verbraucht.${when ? ` Wird ${when} zurückgesetzt.` : ""}`,
    summaryTitle: "Abo-Limits",
    limitReached: "Limit erreicht",
    fiveHours: "5-Stunden",
    weekly: "Wochen",
    hours: (n) => `${n} Std.`,
  },

  spoken: {
    codeBlock: " Ein Code-Detail steht im Text. ",
    pullRequest: (n) => `Pull-Request Nummer ${n}`,
    file: " eine Datei",
    link: "ein Link",
    commit: "ein Commit",
    technicalRef: "eine technische Referenz",
    rest: "Den Rest findest du im Text.",
  },

  pm: {
    capped: (cap) =>
      `Der PM hat sein Ausgabenlimit für diesen Monat erreicht (${cap.toFixed(2)} $), daher frage ich das Modell nicht. ` +
      "Die Berichte bleiben mit `leftoff brief` verfügbar. Du kannst das Limit in config.yaml erhöhen (pm.budget.monthlyUsd).",
    budgetWarn: (spent, cap) => `ℹ️ PM-Ausgaben diesen Monat: ${spent.toFixed(2)} $ von ${cap.toFixed(2)} $ Limit.`,
    refused: "Das Modell hat diese Anfrage abgelehnt. Formuliere sie bitte anders.",
    empty: "Ich konnte keine Antwort formulieren. Versuche es gleich noch einmal.",
    answerIn: "German",
  },

  tasks: {
    addedDecision: "Vom PM zum Backlog hinzugefügt",
    requestWhy: "Wunsch des Inhabers",
  },

  hub: {
    restartScheduled: (count) => ` Automatischer Neustart geplant für ${count === 1 ? "den gestoppten Agenten" : `${count} gestoppte Agenten`}.`,
    resumeInstruction: (product) =>
      `[leftoff] Das Limit von ${product} wurde zurückgesetzt. Mach jetzt genau dort weiter, wo du aufgehört hast. Prüfe zuerst den aktuellen Projektstand, arbeite dann weiter und sende den üblichen Leftoff-Bericht.`,
    autoRestartDecision: "Automatischer Neustart nach dem Zurücksetzen des Limits",
    restartUnreachable: (name) => `⚠️ ${name}: Das Limit wurde zurückgesetzt, aber die Sitzung, die gestoppt war, ist nicht mehr erreichbar. Ich habe keine andere Sitzung an ihrer Stelle neu gestartet.`,
    restartAsked: (name, queued) => `▶️ ${name}: Limit zurückgesetzt; ich habe um Fortsetzung gebeten${queued ? "; in der Warteschlange, weil nicht erreichbar" : ""}.`,
    replyStatus: (who) => `Update von ${who} (vom PM angefordert)`,
    replyInstruction: (who) => `Antwort von ${who} auf deine Anweisung`,
    sayYesToSend: " Sag «ja» zum Senden, oder sag mir, was ich ändern soll.",
    draftShownNote: (summary) => `[Entwurf im Chat gezeigt, wartet auf ein Ja: ${summary}]`,
    statusQuestion:
      "[leftoff] Der Projektmanager bittet um ein Update. Schreibe, sobald du kannst, einen Leftoff-Bericht (leftoff report): was du getan hast, woran du arbeitest, ob du blockiert bist und was du brauchst. Wenn du fertig bist, sag es. Ändere deshalb deinen Plan nicht.",
    dropped: "👍 Verworfen, nichts wurde gesendet.",
    modelDown: (waiting) => `Ich kann gerade nicht antworten: Das Modell ist nicht verfügbar.${waiting ? " Der Entwurf von vorhin wartet noch: «ja» sendet ihn, «nein» verwirft ihn." : ""}`,
    projectGone: "Dieses Projekt gibt es nicht mehr: Es wurde nichts gesendet.",
    capReached: (cap) => `Ich habe in den letzten 24 Stunden bereits ${cap} Anweisungen gesendet, meine eigene Obergrenze. Es wird nichts mehr gesendet; erhöhe commands.maxPerDay, falls nötig.`,
    instructionDecision: (agent, summary) => `Anweisung an ${agent}: ${summary}`,
    instructionWhy: (prompt) => `Im Chat genehmigt und vom PM weitergeleitet. Gesendeter Text:\n${prompt}`,
    sendFailed: "Ich konnte es nicht senden. Der Entwurf ist verloren; sag mir noch einmal, was du willst.",
    noTranscriber: "Ich verstehe vorerst nur Text: Sprachnachrichten sind nicht aktiviert (kein Transkriptions-Schlüssel).",
    voiceTooLong: (seconds, max) => `Die Sprachnachricht ist zu lang (${seconds} s, maximal ${max} s). Teile sie auf oder schreibe sie.`,
    heardNothing: "🎙️ Ich habe nichts Verständliches gehört. Versuche es noch einmal oder schreibe es.",
    notSure: (text) => `🎙️ Ich bin nicht sicher, ob ich das richtig verstanden habe: «${text}». Nimm es noch einmal auf oder schreibe es.`,
    transcribeFailed: "Ich konnte die Sprachnachricht nicht transkribieren. Versuche es noch einmal oder schreibe es.",
    whichProjectMute: "Welches Projekt? Z. B. /mute clipforge 4 (Stunden)",
    muted: (project, until) => `🔕 ${project} stummgeschaltet bis ${until}`,
    unmuted: (project) => `🔔 ${project ?? "Projekt"} wieder aktiv.`,
    quietOn: (start, end) => `🌙 Ruhezeiten sind von ${start} bis ${end} aktiv. Deaktivieren mit /quiet off.`,
    quietOff: "🔔 Ruhezeiten sind aus: Updates kommen zu jeder Zeit. Aktivieren mit /quiet on.",
    whichProjectResume: "Welches Projekt? Nutze /resume <Projekt> [Agent].",
    whichAgentResume: (project, agents) => `Welcher Agent? Nutze /resume ${project} <${agents || "Agent"}>.`,
    manualResumeInstruction:
      "[leftoff] Mach jetzt dort weiter, wo du aufgehört hast. Prüfe zuerst den aktuellen Projektstand, arbeite dann weiter und sende den üblichen Leftoff-Bericht.",
    manualResumeDecision: "Manueller Neustart angefordert bei",
    resumeAsked: (agent, project) => `▶️ ${agent} (${project}): Ich habe um sofortige Fortsetzung gebeten.`,
    resumeQueued: (agent, project) => `📥 ${agent} (${project}): Neustart-Nachricht in der Warteschlange; gerade nicht erreichbar.`,
    voiceUnavailable: "Sprachantworten sind nicht verfügbar (kein Deepgram-Schlüssel).",
    voiceLabel: (mode) =>
      ({
        mirror: "automatisch: Ich antworte per Sprache, wenn du mir per Sprache schreibst",
        always: "immer: Jede Antwort und das Stand-up kommen auch als Sprachnachricht",
        never: "nie: nur Text",
      })[mode],
    voiceStatus: (label) => `🔊 Stimme: ${label}.\nÄndern mit /stimme ein, /stimme aus oder /stimme auto.`,
    languageNow: (name, options) => `🌐 Sprache: ${name}. Ändern mit /sprache ${options}.`,
    languageUnknown: (options) => `Diese Sprache kenne ich nicht. Wähle eine von: ${options}.`,
    alertsStatus: (level) => ({ critical: '🔔 Meldungen: nur kritische — ein Agent, der blockiert ist oder dich braucht, ein erreichtes Limit, die Antwort auf deine Frage. Der Rest steht im Dashboard. Ändern mit /alerts normal oder /alerts all.', normal: '🔔 Meldungen: normal — die kritischen plus erledigte Arbeit und Limit-Warnungen. Ändern mit /alerts critical oder /alerts all.', all: '🔔 Meldungen: alle — alles, auch Commits ohne Bericht. Ändern mit /alerts critical oder /alerts normal.' })[level],
    alertsUnknown: 'Wähle: critical, normal oder all.',
    help: "Schreib mir einfach: „Wo stehen wir?“. Befehle: /overview, /buero [Projekt], /resume <Projekt> [Agent], /quiet on|off, /voice on|off|auto, /language <Code>, /alerts critical|normal|all, /mute <Projekt> [Stunden], /unmute <Projekt>.",
  },
};
