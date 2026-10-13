// Types for choices.js, which is plain JavaScript because the browser loads it as is.

export interface FeedChoice { label: string; reply: string }
export interface FeedEntryLike { id: string; projectId: string | null; role: "pm" | "owner"; source: string; kind: string; choices?: FeedChoice[] }

export function threadOf(entry: Pick<FeedEntryLike, "projectId">): string;
export function liveChoices(feed: Iterable<FeedEntryLike | null | undefined>): Set<string>;
export function choicesOf(entry: Pick<FeedEntryLike, "choices"> | null | undefined): FeedChoice[];
export function optionReply(agentName: string, option: string): string;
