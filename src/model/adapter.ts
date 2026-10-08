/**
 * Model adapter seams. Each turn starts fresh; native messages are retained
 * only through its tool steps. Compaction retries share their own session.
 */

/** Everything a fresh turn needs. The view is rendered by the caller. */
export interface TurnRequest {
  system: string;
  view: string;
  userText: string;
  signal?: AbortSignal;
}

/** A completed entry. Thoughts are readable but never part of the stored log. */
export interface TurnEntry {
  kind: string;
  text: string;
}

/**
 * Yields completed entries for one turn. Callers log user/talk/tool/echo as they
 * finish and never log any other kind (thoughts stay out of the log).
 */
export interface TurnAdapter {
  ask(req: TurnRequest): AsyncIterable<TurnEntry>;
}

/** Provider-neutral function schema; definitions stay constant across calls. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompactionSession {
  reply(feedback?: string): Promise<string>;
}

export interface CompactionAdapter {
  openCompaction(
    contextLines: string[],
    step: string,
    system: string,
    signal?: AbortSignal,
  ): CompactionSession;
}
