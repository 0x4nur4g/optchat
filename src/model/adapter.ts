/**
 * Model adapter seam. One fresh model call per turn: the whole prompt is the
 * system text, the rendered view, and the new user text. Nothing is carried
 * between calls by the adapter itself.
 */

/** One entry of the model's transcript. role uses the log kinds: talk/tool/echo. */
export interface ChatStep {
  role: string;
  text: string;
}

/** Everything a fresh turn needs. The view is rendered by the caller. */
export interface TurnRequest {
  system: string;
  view: string;
  userText: string;
}

/** One streamed model output entry. kinds: talk | tool | echo. */
export interface TurnEntry {
  kind: string;
  text: string;
}

/**
 * Streams model output for one turn. Callers log talk/tool/echo as they
 * finish and never log any other kind (thoughts stay out of the log).
 */
export interface TurnAdapter {
  ask(req: TurnRequest): AsyncIterable<TurnEntry>;
}

/** Test adapter: replays a fixed step list and records each request. */
export class MockAdapter implements TurnAdapter {
  readonly requests: TurnRequest[] = [];

  constructor(private readonly steps: ChatStep[] = [{ role: "talk", text: "ok" }]) {}

  async *ask(req: TurnRequest): AsyncIterable<TurnEntry> {
    this.requests.push(req);
    for (const step of this.steps) {
      yield { kind: step.role, text: step.text };
    }
  }
}