/**
 * Parses a `text/event-stream` body into a sequence of JSON-decoded events.
 *
 * Frames are separated by a blank line and may be split across chunk
 * boundaries by the underlying transport, so this buffers until it has seen
 * a full frame rather than assuming one `read()` maps to one event.
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) yield JSON.parse(data);
    }
  }
}
