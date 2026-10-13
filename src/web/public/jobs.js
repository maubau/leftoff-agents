// What the Home does with the creations of new projects (D-056), kept apart from the page so it can be tested without
// a browser: which cards to show, when a stopped one can be retried, what "Leave it as it is" remembers, and whether
// to ask the hub for its list again.

/** Where the browser keeps the creations the owner left as they are, and how many it keeps. */
export const LEFT_KEY = "leftoff_left_jobs";
export const LEFT_KEEP = 50;

/**
 * The creations left as they are, from what the browser stored. Storage is written by this page but can be anything
 * (an older version, an extension, a hand): whatever is not a list of short strings is read as nothing, never as an error.
 */
export function readLeft(raw) {
  if (typeof raw !== "string" || !raw) return new Set();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 200).slice(-LEFT_KEEP));
}

export function writeLeft(left) {
  return JSON.stringify([...left].slice(-LEFT_KEEP));
}

/** "Leave it as it is": remembered here, and nothing else — no request to the hub, nothing deleted. */
export function leave(left, job) {
  const next = new Set(left);
  next.add(job.id);
  return next;
}

export function failedStep(job) {
  return (job?.steps ?? []).find((step) => step.status === "failed") ?? null;
}

/** A stopped creation can be retried when the hub says its failed step can be. */
export function canRetry(job) {
  return job?.status === "failed" && (job.steps ?? []).some((step) => step.status === "failed" && step.retryable === true);
}

/** The only request Retry makes: resume from the failed step. */
export const retryPath = (job) => `/api/projects/jobs/${encodeURIComponent(job.id)}/retry`;

/**
 * The cards at the top of the Home: creations running or stopped, from any origin, but not finished ones, not the one the
 * form on this page is already showing, and not those left as they are. Oldest first, so cards do not jump.
 */
export function cardsToShow(jobs, { mine = null, left = new Set() } = {}) {
  return [...jobs]
    .filter((job) => job && job.id && job.status !== "done" && job.id !== mine && !left.has(job.id))
    .sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
}

/**
 * After asking the hub for its list of creations: "loaded" when it answered, "unsupported" when it has no such list (404:
 * only the creation started here is followed), "retry" for anything else — a network blip must not hide creations started
 * elsewhere, so the next refresh asks again.
 */
export function listOutcome(error) {
  if (!error) return "loaded";
  return error.status === 404 ? "unsupported" : "retry";
}
