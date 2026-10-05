/** An error whose message is safe and useful to print straight to the user. */
export class UserError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "UserError";
    this.hint = hint;
  }
}
