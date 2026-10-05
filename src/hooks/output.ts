/**
 * Hook responses. Both Claude Code and Codex read JSON on stdout and share the
 * same `hookSpecificOutput` envelope, so these helpers serve both.
 */

/** Inject text into the agent's context at SessionStart / UserPromptSubmit. */
export function additionalContext(event: string, context: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  });
}

/** Stop the agent from ending its turn and tell it what to do instead. */
export function block(reason: string): string {
  return JSON.stringify({ decision: "block", reason });
}

/** Say nothing and let the turn proceed. */
export const proceed = "";

export function emit(output: string): void {
  if (output) process.stdout.write(`${output}\n`);
}
