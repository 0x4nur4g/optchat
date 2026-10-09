// Server-Sent Events parsing for the Responses API stream. Plan usage requires
// `stream: true`, so every inference call is a stream even though the CLI only
// surfaces entries once each response completes.

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parse SSE frames from a byte stream. Yields one event per blank-line frame,
 * with `data:` lines joined by newlines per the SSE spec.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];

  const flush = function* (): Generator<SseEvent> {
    if (data.length === 0 && event === "") return;
    if (data.length > 0) yield { event, data: data.join("\n") };
    event = "";
    data = [];
  };

  const handleLine = function* (line: string): Generator<SseEvent> {
    if (line === "") {
      yield* flush();
      return;
    }
    if (line.startsWith(":")) return; // comment
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield* handleLine(line);
      newline = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  for (const line of buffer.split("\n")) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    yield* handleLine(trimmed);
  }
  yield* flush();
}

/** Parse SSE frames and yield the JSON payload of each `data` line. */
export async function* parseSseJson(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  for await (const frame of parseSse(stream)) {
    try {
      const parsed: unknown = JSON.parse(frame.data);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        yield parsed as Record<string, unknown>;
      }
    } catch {
      // A frame that is not JSON cannot describe model output; skip it rather
      // than abort a long turn over one malformed line.
    }
  }
}
