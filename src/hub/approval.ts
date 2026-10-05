/**
 * Does this message approve or cancel the draft waiting in the thread?
 *
 * Deliberately a fixed list, not the model's judgement: whether something goes
 * to an agent is decided by words the owner said, matched here, so no text the
 * PM has read — a report, a commit message — can ever trigger a send. Anything
 * that is not exactly one of these ("ok ma aggiungi i test", "no, fai X") goes
 * to the PM as a request for changes.
 */
/** Lower case, no accents, no punctuation: «Sí», «Vas-y !» and «não» all reduce to plain words. */
const normalise = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // sì → si
    .replace(/[^a-z0-9' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The words of every supported language are accepted together, whichever one the PM speaks:
 * the owner can answer in the language they think in, and the list stays a fixed, closed set.
 */
const FILLER =
  "(?: (?:si|ok|vai|pure|ora|subito|grazie|per favore|manda(?:lo|la)?|invia(?:lo|la)?" +
  "|bitte|danke|jetzt|gleich|merci|maintenant|s'il vous plait|s'il te plait|vite|gracias|ahora|por favor|ya|obrigado|obrigada|agora|por favor|obg))*";

const APPROVE = new RegExp(
  "^(?:" +
    // it
    "si|ok|okay|va bene|vai|manda(?:lo|la)?|invia(?:lo|la)?|conferma|confermo|perfetto|certo|procedi|d'?accordo|esatto|" +
    // en
    "yes|go|send(?: it)?|" +
    // de
    "ja|jawohl|genau|einverstanden|in ordnung|passt|schick(?: es)?|sende(?: es)?|senden|abschicken|bestatigt|bestatige|los|" +
    // fr
    "oui|d'accord|envoie(?: le| la)?|envoyer|vas y|confirme|parfait|exactement|" +
    // es
    "vale|claro|adelante|envialo|enviala|enviar|de acuerdo|confirmo|perfecto|exacto|" +
    // pt
    "sim|pode enviar|envia(?: o| a)?|manda(?: o| a)?|enviar|perfeito|exatamente|confirmado|combinado" +
    ")" +
    FILLER +
    "$",
);

const CANCEL = new RegExp(
  "^(?:" +
    // it
    "no|annulla(?:lo|la)?|cancella(?:lo|la)?|lascia stare|lascia perdere|stop|niente|non mandarlo|non mandarla|non inviarlo|non inviarla|non mandare|non inviare|" +
    // en
    "cancel|" +
    // de
    "nein|abbrechen|abbruch|lass es|lass gut sein|nicht senden|nicht schicken|vergiss es|" +
    // fr
    "non|annule(?:r)?|laisse tomber|ne l'envoie pas|n'envoie pas|laisse|" +
    // es
    "cancela(?:r|lo|la)?|dejalo|dejalo estar|olvidalo|no lo envies|no lo mandes|no envies|" +
    // pt
    "nao|cancela(?:r)?|deixa|deixa pra la|deixa para la|nao envies|nao envie|nao mandes|nao mande|esquece" +
    ")(?: (?:grazie|pure|ora|per favore|bitte|danke|merci|gracias|por favor|obrigado|obrigada))*$",
);

export function isApproval(text: string): boolean {
  return APPROVE.test(normalise(text));
}

export function isCancellation(text: string): boolean {
  return CANCEL.test(normalise(text));
}
