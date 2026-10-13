import type { Messages } from "./types.ts";

const INBOX_REASON: Record<string, string> = {
  "the Paseo session is closed": "a sessão do Paseo está fechada",
  "agent unknown": "não o conheço",
  "not run by Paseo": "não é gerido pelo Paseo",
};

export const pt: Messages = {
  name: "Português",

  report: {
    and: "e",
    taskFallback: "a sua tarefa",
    finished: (who, what) => `✅ ${who} terminou: ${what}.`,
    decisions: (items) => `Decisões: ${items}`,
    findings: (items) => `Descobertas: ${items}`,
    next: (items) => `A seguir: ${items}`,
    nowIdle: "Agora está parado. O que deve fazer?",
    blocked: (who, reason) => `⛔ ${who} está bloqueado: ${reason}.`,
    noReason: "motivo não indicado",
    recommends: (option) => `Recomenda: ${option}`,
    doneSoFar: (items) => `Feito até agora: ${items}`,
    needsYou: (who) => `❓ ${who} precisa de você.`,
    nextStep: (items) => `Próximo passo: ${items}`,
    done: (items) => `Feito: ${items}`,
    idle: (who, lastWork) => `💤 ${who} está parado.${lastWork ? ` Último trabalho: ${lastWork}.` : ""}`,
    suggests: (items) => `Propostas: ${items}`,
    whatShouldItDo: "O que deve fazer?",
  },

  delivery: {
    reason: (english) => INBOX_REASON[english] ?? "não está disponível agora",
    draftBusy: "🟢 Está trabalhando: entrego quando terminar o turno atual, sem interrompê-lo.",
    draftIdle: "💤 Está parado: esta mensagem vai colocá-lo em ação de novo.",
    sentBusy: "Está trabalhando: entrego quando terminar o turno atual, sem interrompê-lo.",
    sentIdle: "Estava parado: recomeça agora.",
    delivered: (agent, project, live) => (live ? `📨 Entregue a ${agent} (${project}): tinha terminado o turno.` : `📨 ${agent} (${project}) não está mais no Paseo: a mensagem está na caixa de entrada dele, para a próxima sessão.`),
    unreachable: (why) => `📥 Não está disponível agora (${why}): a mensagem espera na caixa dele e eu entrego assim que a sessão no Paseo estiver ativa de novo, ou ele lê na próxima sessão.`,
    draftHeader: (agent, project) => `📨 Rascunho para ${agent} — ${project}`,
    approveHint: (ttl) => `Responda «sim» para enviar, «não» para descartar, ou diga o que mudar. (Válido por ${ttl >= 60 ? `${Math.round(ttl / 60)} h` : `${ttl} min`}.)`,
    sent: (agent, project) => `Enviado para ${agent} (${project}).`,
    waiting: (agent, project) => `Ainda não enviado: aguardando ${agent} (${project}).`,
    willTell: "Aviso você quando ele responder.",
    choiceSend: "✅ Sim, enviar",
    choiceDrop: "✖ Não",
    yesWord: "sim",
    noWord: "não",
  },

  handoff: {
    header: (from, to, project) => `🤝 Passagem de tarefa — ${from} → ${to} (${project})`,
    instruction: (p) =>
      [
        `Pedido do seu colega ${p.from}${p.role ? ` (${p.role})` : ""}, encaminhado pelo gerente de projeto com a aprovação do responsável:`,
        "",
        `«${p.ask}»`,
        "",
        `Contexto: o relatório dele ${p.report}${p.branch ? `, branch ${p.branch}` : ""}${p.commits.length ? `, commits ${p.commits.join(", ")}` : ""}.`,
        "Se for tarefa sua, faça; se não for, ou se precisar de algo antes, diga isso no seu relatório.",
        `Quando terminar, relate como sempre. Se ${p.from} precisar saber ou fazer algo, adicione --handoff "${p.fromId}: <o quê>".`,
      ].join("\n"),
    unknownTarget: (from, to, ask, team) => `🤝 ${from} precisa de «${ask}» de «${to}», mas nenhum agente do projeto corresponde. Equipe: ${team}. Diga-me quem deve fazer, ou dê um papel aos agentes (leftoff agents role).`,
    decision: (from, to, ask) => `Passagem de tarefa aprovada: ${from} → ${to}: ${ask}`,
    reply: (who, from) => `Resposta de ${who} ao pedido de ${from}`,
    expired: (from, to) => `⌛ A passagem de tarefa ${from} → ${to} expirou sem resposta. Peça-me para reenviar se ainda importar.`,
  },

  modes: {
    name: { control: "controlado", autonomous: "autônomo" },
    changed: (project, mode) => (mode === "autonomous" ? `🤖 ${project}: modo autônomo. O que você pede, e os repasses entre colegas, saem sem esperar o seu sim; eu aviso a cada vez. Ações destrutivas ou irreversíveis, e as minhas próprias ideias, continuam esperando por você.` : `✋ ${project}: modo controlado. Cada instrução a um agente espera o seu sim.`),
    already: (project, mode) => `${project} já está no modo ${({ control: "controlado", autonomous: "autônomo" })[mode]}.`,
    confirm: (project) => `Ativo o modo autônomo para ${project}? Suas instruções e os repasses entre colegas sairão sem perguntar antes.`,
    risky: `⚠️ Modo autônomo, mas esta precisa do seu sim: parece destrutiva ou irreversível.`,
    braked: (n) => `⚠️ Modo autônomo, mas na última hora já foram repassadas sozinhas ${n} passagens de tarefa: esta espera o seu sim, caso os agentes estejam andando em círculos.`,
    initiative: `Modo autônomo, mas é ideia minha, não um pedido seu: precisa do seu sim.`,
    handoffForwarded: (from, to, project, ask) => `🤝 Repassado automaticamente (modo autônomo): ${from} → ${to} (${project})\n«${ask}»`,
    autoWhy: `modo autônomo: enviada sem pedir o sim`,
    decision: (mode) => `Modo do gerente de projeto: ${({ control: "controlado", autonomous: "autônomo" })[mode]}`,
  },

  plan: {
    request: (p) =>
      [
        `O responsável quer planejar antes de começar o desenvolvimento: «${p.goal}» (${p.project}). Ainda não comece a implementar.`,
        `Proponha a sua parte do plano${p.role ? " como " + p.role : ""}: só os passos principais, em geral de 3 a 10 tarefas. Para cada uma execute:`,
        `  leftoff plan add --agent ${p.agent} --plan ${p.planId} --phase "1 · <fase>" --title "<o que é feito>" --description "<objetivo, contexto, o que fica de fora>" --criteria "<como saber que está pronta>" --depends <TASK-id de que depende>`,
        `Veja as tarefas dos colegas com \`leftoff plan show\` e aponte para elas com --depends quando precisar do trabalho deles antes. Numere as fases (1 · …, 2 · …).`,
        `Depois faça o relatório como de costume. O trabalho começa quando o responsável aprovar o plano.`,
      ].join("\n"),
    ready: (goal, project, tasks) => `📋 Plano para «${goal}» (${project}): todos os agentes enviaram sua parte, ${tasks} tarefas. Me diga «prepare o plano» e eu consolido para sua aprovação.`,
    partial: (goal, project, tasks, missing) => `📋 Plano para «${goal}» (${project}): até agora ${tasks} tarefas; ainda faltam: ${missing}. Posso consolidar com o que chegou.`,
    none: (goal, project, missing) => `📋 Plano para «${goal}» (${project}): nenhum agente enviou ainda sua parte (pedido a: ${missing}).`,
    shownHeader: (goal, project) => `📋 Plano para «${goal}» (${project}) — aguardando sua aprovação`,
    after: (ids) => `depois de ${ids}`,
    approveHint: (ttlMinutes) => `Responda «sim» para aprová-lo e começar o desenvolvimento, «não» para revisá-lo. (Válido ${Math.round(ttlMinutes / 60)} h.)`,
    approved: (goal, project, tasks) => `✅ Plano aprovado: «${goal}» (${project}), ${tasks} tarefas. Cada agente recebeu as suas, em ordem.`,
    revise: `Plano não aprovado: me diga o que mudar.`,
    start: (p) =>
      [
        `O plano «${p.goal}» está aprovado. Suas tarefas, em ordem:`,
        `${p.tasks}`,
        `Comece pelas que têm as dependências concluídas. Quando começar ou terminar uma: leftoff plan set <TASK-id> "In Progress" (ou "Done") --agent ${p.agent}. Faça o relatório como de costume.`,
      ].join("\n"),
    decision: (goal, tasks, phases) => `Plano aprovado: «${goal}» (${tasks} tarefas em ${phases} fases)`,
  },

  newProject: {
    draft: (name, folder) => `🆕 Novo projeto «${name}»\nVou criar a pasta ${folder}, um repositório git e o projeto Leftoff, e registrá-lo no Paseo.\nResponda «sim» para criar, «não» para deixar.`,
    paseoDown: "O Paseo não responde agora: o projeto será criado e o passo do Paseo espera outra tentativa.",
    dropped: "Deixado de lado. Nada foi criado.",
    creating: (name) => `⏳ Criando «${name}»…`,
    done: (name) => `✅ Projeto «${name}» criado.`,
    failed: (name, step, reason) => `⚠️ «${name}» foi feito até o passo «${step}»: ${reason}`,
    steps: { folder: "pasta", repository: "repositório git", leftoff: "projeto Leftoff", registry: "registro", paseo: "Paseo" },
    buttons: { openPanel: "Abrir o painel", addAgent: "Adicionar um agente", retry: "Tentar de novo", leave: "Deixar como está" },
    invalid: { empty: "Dê um nome ao projeto.", tooLong: (max) => `O nome é longo demais (no máximo ${max} caracteres).`, badChars: "O nome tem caracteres que uma pasta não pode ter.", reserved: "Esse nome é reservado. Escolha outro.", noId: "Não consigo fazer uma pasta com este nome: use letras latinas ou números." },
    exists: (kind) => (kind === "folder" ? "Já existe uma pasta com esse nome." : kind === "paseo" ? "O Paseo já tem um projeto com esse nome." : "Já existe um projeto com esse nome."),
    usage: "Diga-me o nome: /novoprojeto <nome>",
    busy: "Nesta conversa já há algo esperando o seu sim: decida isso primeiro e depois peça o projeto de novo.",
  },

  activity: {
    instruction: (agent, summary) => `📤 Instrução para ${agent}: «${summary}»`,
    planAsked: (agent, goal) => `🗺️ Pedida a ${agent} a sua parte do plano: «${goal}»`,
    statusAsked: (agent, queued) => (queued ? `❔ Pedido o estado a ${agent}: vai lê-lo no fim do turno.` : `❔ Pedido o estado a ${agent}.`),
    task: (id, title, status) => `📋 ${id} ${status === "Done" ? "concluída" : "em curso"}: ${title}`,
    digest: (count, project, lines) =>
      [
        `🗂️ ${count} avisos${project ? ` sobre ${project}` : ""}, agrupados para não te escrever com tanta frequência:`,
        ...lines.map((l) => `• ${l}`),
        ...(count > lines.length ? [`… e mais ${count - lines.length}.`] : []),
        "Os detalhes estão no painel.",
      ].join("\n"),
  },

  newAgent: {
    firstPrompt: (p) =>
      [
        `Você é ${p.name}, um novo agente da equipe de ${p.project}, criado pelo responsável a partir do Leftoff.`,
        ...(p.role ? [`Seu papel: ${p.role}.`] : []),
        "",
        ...(p.task ? [`Sua primeira tarefa:`, "", p.task] : [`Ainda sem tarefa: conheça o projeto (README, relatórios recentes em .leftoff/), depois faça o relatório com status idle e aguarde instruções.`]),
        "",
        `Seus colegas e como fazer o relatório estão no briefing que você recebe no início da sessão. Quando terminar, faça o relatório como de costume.`,
      ].join("\n"),
  },

  office: {
    title: (project) => `🏢 ${project} — o escritório`,
    states: { working: "trabalhando", blocked: "bloqueado", needs: "precisa de você", awaiting: "aguarda resposta", done: "terminou", idle: "parado" },
    handoff: (from, to, ask) => `🤝 ${from} → ${to}: ${ask}`,
    whichProject: "Qual projeto? Escreva /escritorio <projeto>, ou envie no tópico do projeto.",
    noAgents: (project) => `Ainda não há agentes em ${project}: eles aparecem após o primeiro relatório.`,
  },

  unreported: {
    head: (count, branch) => `⚠️ ${count} commit${count === 1 ? "" : "s"}${branch ? ` em ${branch}` : ""} sem relatório.`,
    andMore: (count) => `…e mais ${count}`,
    askSummary: "Quer que eu peça um resumo ao agente?",
  },

  standup: {
    title: (weekday) => `📋 Stand-up de ${weekday}`,
    noReports: "nenhum relatório desde que o acompanho",
    reportsLastDay: (count) => `${count} relatório${count === 1 ? "" : "s"} nas últimas 24 h`,
    quietDays: (days) => `parado há ${days} ${days === 1 ? "dia" : "dias"}`,
    next: "a seguir",
    unreportedCommits: (count) => `⚠️ ${count} commit${count === 1 ? "" : "s"} sem relatório`,
    nothingNew: "sem novidades",
    notReported: "não informado",
    usd: (value) => `US$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    spend: (dev, pm) => `Gasto dos últimos 7 dias: desenvolvimento ${dev}, PM ${pm}`,
  },

  limits: {
    windowName: (product, label) => `${product}, janela ${label}`,
    atTime: (hhmm) => `às ${hhmm}`,
    tomorrowAt: (hhmm) => `amanhã às ${hhmm}`,
    dateAt: (date, hhmm) => `${date} às ${hhmm}`,
    inRel: (when, rel) => `${when} (em ${rel})`,
    now: "agora",
    reachedWhen: (name, when) => `⛔ ${name} atingiu o limite. Libera ${when}.`,
    reachedPlain: (name) => `⛔ ${name} atingiu o limite.`,
    reachedUnknown: (name) => `⛔ ${name} atingiu o limite. Não sei quando libera: aviso assim que voltar a funcionar.`,
    shouldBeBack: (name, when) => `✅ ${name} deve estar disponível de novo (o limite vencia ${when}).`,
    back: (name) => `✅ ${name} está disponível de novo.`,
    windowReset: (name) => `✅ ${name} está disponível de novo: a janela foi reiniciada.`,
    used: (percent) => `${Math.round(percent)}% usado`,
    warn: (name, percent, when) => `⚠️ ${name}: ${Math.round(percent)}% usado.${when ? ` Reinicia ${when}.` : ""}`,
    summaryTitle: "Limites das assinaturas",
    limitReached: "limite atingido",
    fiveHours: "5 horas",
    weekly: "semanal",
    hours: (n) => `${n} h`,
  },

  spoken: {
    codeBlock: " Há um detalhe de código disponível no texto. ",
    pullRequest: (n) => `a pull request número ${n}`,
    file: " um arquivo",
    link: "um link",
    commit: "um commit",
    technicalRef: "uma referência técnica",
    rest: "O resto está no texto.",
  },

  pm: {
    capped: (cap) =>
      `O PM atingiu o teto de gastos deste mês (US$ ${cap.toFixed(2)}), então não consulto o modelo. ` +
      "Os relatórios continuam disponíveis com `leftoff brief`. Você pode aumentar o teto em config.yaml (pm.budget.monthlyUsd).",
    budgetWarn: (spent, cap) => `ℹ️ Gasto do PM neste mês: US$ ${spent.toFixed(2)} de um teto de US$ ${cap.toFixed(2)}.`,
    refused: "O modelo recusou este pedido. Tente reformulá-lo.",
    empty: "Não consegui formular uma resposta. Tente de novo em instantes.",
    answerIn: "Portuguese",
  },

  tasks: {
    addedDecision: "Adicionadas ao backlog pelo PM",
    requestWhy: "Pedido do proprietário",
  },

  hub: {
    restartScheduled: (count) => ` Reinício automático programado para ${count === 1 ? "o agente parado" : `${count} agentes parados`}.`,
    resumeInstruction: (product) =>
      `[leftoff] O limite do ${product} foi reiniciado. Retome agora exatamente de onde parou. Primeiro verifique o estado atual do projeto; depois continue e envie o relatório Leftoff de sempre.`,
    autoRestartDecision: "Reinício automático após a renovação do limite",
    restartUnreachable: (name) => `⚠️ ${name}: o limite foi reiniciado, mas a sessão que tinha parado não está mais disponível. Não reiniciei nenhuma outra sessão no lugar dela.`,
    restartAsked: (name, queued) => `▶️ ${name}: limite reiniciado; pedi para retomar${queued ? "; na fila porque não está disponível" : ""}.`,
    replyStatus: (who) => `Atualização de ${who} (pedida pelo PM)`,
    replyInstruction: (who) => `Resposta de ${who} à sua instrução`,
    sayYesToSend: " Diga «sim» para enviar, ou diga o que mudar.",
    draftShownNote: (summary) => `[Rascunho mostrado no chat, aguardando um sim: ${summary}]`,
    statusQuestion:
      "[leftoff] O project manager pede uma atualização. Assim que puder, escreva um relatório Leftoff (leftoff report): o que você fez, o que está fazendo, se está bloqueado e do que precisa. Se terminou, diga. Não mude seu plano por causa disso.",
    dropped: "👍 Descartado, nada foi enviado.",
    modelDown: (waiting) => `Não consigo responder agora: o modelo está indisponível.${waiting ? " O rascunho de antes continua aguardando: «sim» envia, «não» descarta." : ""}`,
    projectGone: "Esse projeto não existe mais: nada foi enviado.",
    capReached: (cap, project) => `Já enviei ${cap} instruções para ${project} nas últimas 24 horas, meu teto por projeto. Não envio mais; aumente commands.maxPerDay se precisar.`,
    instructionDecision: (agent, summary) => `Instrução para ${agent}: ${summary}`,
    instructionWhy: (prompt) => `Aprovada no chat e repassada pelo PM. Texto enviado:\n${prompt}`,
    sendFailed: "Não consegui enviar. O rascunho se perdeu: diga de novo o que você quer.",
    noTranscriber: "Por enquanto só entendo texto: as mensagens de voz não estão ativadas (falta a chave do transcritor).",
    voiceTooLong: (seconds, max) => `A mensagem de voz é longa demais (${seconds} s, máximo ${max} s). Divida-a ou escreva.`,
    heardNothing: "🎙️ Não entendi nada com clareza. Tente de novo ou escreva.",
    notSure: (text) => `🎙️ Não tenho certeza de ter entendido: «${text}». Grave de novo ou escreva.`,
    transcribeFailed: "Não consegui transcrever a mensagem de voz. Tente de novo ou escreva.",
    whichProjectMute: "Qual projeto? Ex.: /mute clipforge 4 (horas)",
    muted: (project, until) => `🔕 ${project} silenciado até ${until}`,
    unmuted: (project) => `🔔 ${project ?? "Projeto"} ativo de novo.`,
    quietOn: (start, end) => `🌙 O horário de silêncio está ativo das ${start} às ${end}. Desative com /quiet off.`,
    quietOff: "🔔 O horário de silêncio está desativado: as atualizações chegam a qualquer hora. Ative com /quiet on.",
    whichProjectResume: "Qual projeto? Use /resume <projeto> [agente].",
    whichAgentResume: (project, agents) => `Qual agente? Use /resume ${project} <${agents || "agente"}>.`,
    manualResumeInstruction:
      "[leftoff] Retome agora de onde parou. Primeiro verifique o estado atual do projeto; depois continue e envie o relatório Leftoff de sempre.",
    manualResumeDecision: "Reinício manual solicitado a",
    resumeAsked: (agent, project) => `▶️ ${agent} (${project}): pedi para retomar agora.`,
    resumeQueued: (agent, project) => `📥 ${agent} (${project}): mensagem de reinício na fila; não está disponível agora.`,
    voiceUnavailable: "As respostas por voz não estão disponíveis (falta a chave do Deepgram).",
    voiceLabel: (mode) =>
      ({
        mirror: "auto: respondo por voz quando você me escreve por voz",
        always: "sempre: cada resposta e o stand-up também vêm com voz",
        never: "nunca: só texto",
      })[mode],
    voiceStatus: (label) => `🔊 Voz: ${label}.\nMude com /voz on, /voz off ou /voz auto.`,
    languageNow: (name, options) => `🌐 Idioma: ${name}. Mude com /lingua ${options}.`,
    languageUnknown: (options) => `Não conheço esse idioma. Escolha um de: ${options}.`,
    alertsStatus: (level) => ({ critical: '🔔 Avisos: só críticos — um agente bloqueado ou que precisa de você, um limite atingido, a resposta ao que você pediu. O resto está no painel. Mude com /alerts normal ou /alerts all.', normal: '🔔 Avisos: normais — os críticos mais o trabalho concluído e os alertas de limite. Mude com /alerts critical ou /alerts all.', all: '🔔 Avisos: todos — como os normais: os passos entre o PM e os agentes ficam no registo de atividade do painel. Mude com /alerts critical ou /alerts normal.' })[level],
    alertsUnknown: 'Escolha entre: critical, normal, all.',
    help: "Escreva normalmente: «em que pé estamos?». Comandos: /overview, /escritorio [projeto], /resume <projeto> [agente], /quiet on|off, /voice on|off|auto, /language <código>, /alerts critical|normal|all, /mute <projeto> [horas], /unmute <projeto>.",
  },
};
