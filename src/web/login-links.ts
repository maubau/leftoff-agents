import { randomBytes } from "node:crypto";

/**
 * One-time links into the panel (D-073): asked for in Telegram with /panel, so the panel's password never travels.
 * Each link opens once, within ten minutes; it then sets the same cookie the password link sets. Kept in memory: a hub
 * restart voids every link not yet opened, which only means asking again.
 */
export const LOGIN_TTL_MS = 10 * 60_000;

export class LoginLinks {
  readonly #links = new Map<string, number>();

  issue(now = Date.now()): string {
    for (const [code, until] of this.#links) if (until <= now) this.#links.delete(code);
    const code = randomBytes(24).toString("base64url");
    this.#links.set(code, now + LOGIN_TTL_MS);
    return code;
  }

  /** True once for a live code; never again. */
  consume(code: string, now = Date.now()): boolean {
    const until = this.#links.get(code);
    this.#links.delete(code);
    return until !== undefined && until > now;
  }
}
