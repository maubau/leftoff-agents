/**
 * Everything Leftoff says on its own, in the owner's language. One catalog per language, each
 * required by the compiler to provide every entry below: a language cannot be half there.
 * Sentences with numbers or names are functions, because word order and plurals differ by language.
 */
export interface Messages {
  /** The language's own name, for `/lingua` and the panel's selector. */
  name: string;

  report: {
    /** "A, B and C" */
    and: string;
    taskFallback: string;
    finished(who: string, what: string): string;
    decisions(items: string): string;
    findings(items: string): string;
    next(items: string): string;
    nowIdle: string;
    blocked(who: string, reason: string): string;
    noReason: string;
    recommends(option: string): string;
    doneSoFar(items: string): string;
    needsYou(who: string): string;
    nextStep(items: string): string;
    done(items: string): string;
    idle(who: string, lastWork: string): string;
    suggests(items: string): string;
    whatShouldItDo: string;
  };

  delivery: {
    /** Why a message waits in an inbox, translated from Leftoff's own English reasons. */
    reason(english: string): string;
    draftBusy: string;
    draftIdle: string;
    sentBusy: string;
    sentIdle: string;
    unreachable(why: string): string;
    draftHeader(agent: string, project: string): string;
    approveHint(ttlMinutes: number): string;
    sent(agent: string, project: string): string;
    willTell: string;
    /** The buttons under a draft, and the words each one says for the owner (they must be on the approval lists). */
    choiceSend: string;
    choiceDrop: string;
    yesWord: string;
    noWord: string;
  };

  /** Work one agent asks of a teammate, passed on by the PM once the owner approves (D-036). */
  handoff: {
    header(from: string, to: string, project: string): string;
    /** What the receiving agent reads: the ask, who sent it, and how to answer. */
    instruction(p: { from: string; fromId: string; role: string | null; ask: string; report: string; branch: string | null; commits: string[] }): string;
    unknownTarget(from: string, to: string, ask: string, team: string): string;
    decision(from: string, to: string, ask: string): string;
    reply(who: string, from: string): string;
    expired(from: string, to: string): string;
  };

  /** The picture of a project's office, and the words under it. */
  office: {
    title(project: string): string;
    states: Record<"working" | "blocked" | "needs" | "awaiting" | "done" | "idle", string>;
    handoff(from: string, to: string, ask: string): string;
    whichProject: string;
    noAgents(project: string): string;
  };

  unreported: {
    head(count: number, branch: string | null): string;
    andMore(count: number): string;
    askSummary: string;
  };

  standup: {
    title(weekday: string): string;
    noReports: string;
    reportsLastDay(count: number): string;
    quietDays(days: number): string;
    next: string;
    unreportedCommits(count: number): string;
    nothingNew: string;
    notReported: string;
    usd(value: number): string;
    spend(dev: string, pm: string): string;
  };

  limits: {
    windowName(product: string, label: string): string;
    atTime(hhmm: string): string;
    tomorrowAt(hhmm: string): string;
    dateAt(date: string, hhmm: string): string;
    inRel(when: string, rel: string): string;
    now: string;
    reachedWhen(name: string, when: string): string;
    reachedPlain(name: string): string;
    reachedUnknown(name: string): string;
    shouldBeBack(name: string, when: string): string;
    back(name: string): string;
    windowReset(name: string): string;
    used(percent: number): string;
    warn(name: string, percent: number, when: string | null): string;
    summaryTitle: string;
    limitReached: string;
    fiveHours: string;
    weekly: string;
    hours(n: number): string;
  };

  spoken: {
    codeBlock: string;
    pullRequest(n: string): string;
    file: string;
    link: string;
    commit: string;
    technicalRef: string;
    rest: string;
  };

  pm: {
    capped(cap: number): string;
    budgetWarn(spent: number, cap: number): string;
    refused: string;
    empty: string;
    /** For the model: the language to answer in when the owner's own words do not say. */
    answerIn: string;
  };

  tasks: {
    addedDecision: string;
    requestWhy: string;
  };

  hub: {
    restartScheduled(count: number): string;
    resumeInstruction(product: string): string;
    autoRestartDecision: string;
    restartUnreachable(name: string): string;
    restartAsked(name: string, queued: boolean): string;
    replyStatus(who: string): string;
    replyInstruction(who: string): string;
    statusQuestion: string;
    sayYesToSend: string;
    draftShownNote(summary: string): string;
    dropped: string;
    modelDown(draftWaiting: boolean): string;
    projectGone: string;
    capReached(cap: number): string;
    instructionDecision(agent: string, summary: string): string;
    instructionWhy(prompt: string): string;
    sendFailed: string;
    noTranscriber: string;
    voiceTooLong(seconds: number, max: number): string;
    heardNothing: string;
    notSure(text: string): string;
    transcribeFailed: string;
    whichProjectMute: string;
    muted(project: string, until: string): string;
    unmuted(project: string | null): string;
    quietOn(start: string, end: string): string;
    quietOff: string;
    whichProjectResume: string;
    whichAgentResume(project: string, agents: string): string;
    manualResumeInstruction: string;
    manualResumeDecision: string;
    resumeAsked(agent: string, project: string): string;
    resumeQueued(agent: string, project: string): string;
    voiceUnavailable: string;
    voiceLabel(mode: "mirror" | "always" | "never"): string;
    voiceStatus(label: string): string;
    languageNow(name: string, options: string): string;
    languageUnknown(options: string): string;
    alertsStatus(level: "critical" | "normal" | "all"): string;
    alertsUnknown: string;
    help: string;
  };
}
