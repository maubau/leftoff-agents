/**
 * Does this instruction look destructive, irreversible or costly? Even in autonomous mode such a thing
 * waits for the owner's yes (D-041). The PM flags them too; this is the fixed check underneath, in code,
 * that no text it read can talk out of it. A heuristic: it errs towards asking, and a miss is still
 * subject to the PM's own flag, the daily cap and the decisions log.
 */
const PATTERNS: RegExp[] = [
  // git history and files
  /\bforce[- ]?push|push\s+(?:-f\b|--force)|--force-with-lease/i,
  /\breset\s+--hard\b|\bclean\s+-[a-z]*f|\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i,
  // deleting things that matter: branches, data, databases, repositories, releases
  /\b(?:delete|remove|drop|wipe|purge|truncate|destroy|erase)\b[^.\n]{0,40}\b(?:branch(?:es)?|database|db|tables?|data|repo(?:sitory)?|bucket|releases?|tags?|backups?|users?|accounts?|production|prod)\b/i,
  /\b(?:cancella|elimina|rimuovi|svuota|distruggi)\w*\b[^.\n]{0,40}\b(?:branch|database|db|tabell[ae]|dati|repo(?:sitory)?|bucket|release|tag|backup|utenti|account|produzione)\b/i,
  /\b(?:lösch|entfern)\w*\b[^.\n]{0,40}\b(?:branch|datenbank|tabelle|daten|repo|release|tag|backup|benutzer|konto|produktion)\b/i,
  /\b(?:supprim|effac)\w*\b[^.\n]{0,40}\b(?:branche|base de donn|table|donn[ée]es|d[ée]p[ôo]t|release|tag|sauvegarde|utilisateur|compte|production)\b/i,
  /\b(?:borr|elimin)\w*\b[^.\n]{0,40}\b(?:rama|base de datos|tabla|datos|repositorio|release|etiqueta|copia de seguridad|usuarios?|cuentas?|producci[óo]n)\b/i,
  /\b(?:apag|exclu|remov)\w*\b[^.\n]{0,40}\b(?:branch|banco de dados|tabela|dados|reposit[óo]rio|release|tag|backup|usu[áa]rios?|contas?|produ[çc][ãa]o)\b/i,
  /\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b/i,
  // shipping to the world
  /\b(?:deploy|release|ship|publish|rilascia|pubblica|distribuisci|ver[öo]ffentlich|d[ée]ploie|publie|despliega|publica|implanta)\w*\b[^.\n]{0,40}\b(?:prod(?:uction|uzione|uktion|ucci[óo]n|u[çc][ãa]o)?|live|npm|pypi|app store|play store)\b/i,
  /\bnpm\s+publish\b|\bgh\s+release\s+create\b|\bterraform\s+(?:apply|destroy)\b|\bkubectl\s+delete\b/i,
  // spending money: purchase verbs, or paying for / subscribing to something
  /\b(?:buy|purchase|acquista|acquistare|compra|comprare|kaufe|kaufen|ach[eè]te|acheter|assina|assinar)\b/i,
  /\b(?:pay for|subscribe to|upgrade (?:the |our )?plan|paga(?:re)? (?:il|lo|la|un|una)\b|abbonati a|sottoscrivi|bezahle|abonniere|paye[rz]? (?:le|la|un)|suscr[ií]bete|pague (?:o|a|um))/i,
];

export function looksIrreversible(text: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(text));
}
