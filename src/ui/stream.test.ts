import { describe, expect, it } from "vitest";
import { readEventStream } from "./stream.ts";

/** Builds a ReadableStream that yields exactly the given chunks, in order. */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of readEventStream(body)) {
    events.push(event);
  }
  return events;
}

describe("readEventStream", () => {
  it("parses a single frame delivered in one chunk", async () => {
    const body = streamFromChunks([`data: {"type":"iteration","n":1}\n\n`]);
    expect(await collect(body)).toEqual([{ type: "iteration", n: 1 }]);
  });

  it("parses multiple frames arriving in a single chunk", async () => {
    const body = streamFromChunks([
      `data: {"type":"iteration","n":1}\n\ndata: {"type":"iteration","n":2}\n\n`,
    ]);
    expect(await collect(body)).toEqual([
      { type: "iteration", n: 1 },
      { type: "iteration", n: 2 },
    ]);
  });

  it("reassembles a frame split mid-JSON across two chunks", async () => {
    const frame = `data: {"type":"tool_start","id":"t1","name":"getFinancials","label":"Fetching financials for Acme Corp"}\n\n`;
    const mid = Math.floor(frame.length / 2);
    const body = streamFromChunks([frame.slice(0, mid), frame.slice(mid)]);
    expect(await collect(body)).toEqual([
      {
        type: "tool_start",
        id: "t1",
        name: "getFinancials",
        label: "Fetching financials for Acme Corp",
      },
    ]);
  });

  it("reassembles a frame delivered one character at a time", async () => {
    const frame = `data: {"type":"answer_delta","text":"hi"}\n\n`;
    const body = streamFromChunks(frame.split(""));
    expect(await collect(body)).toEqual([{ type: "answer_delta", text: "hi" }]);
  });

  it("round-trips a delta whose text contains a newline", async () => {
    const payload = { type: "answer_delta", text: "line one\nline two" };
    const body = streamFromChunks([`data: ${JSON.stringify(payload)}\n\n`]);
    expect(await collect(body)).toEqual([payload]);
  });

  it("ignores comment lines and frames with no data", async () => {
    const body = streamFromChunks([
      `: keep-alive\n\ndata: {"type":"done","answer":"ok","iterations":1}\n\n`,
    ]);
    expect(await collect(body)).toEqual([{ type: "done", answer: "ok", iterations: 1 }]);
  });

  it("yields nothing for an empty stream", async () => {
    const body = streamFromChunks([]);
    expect(await collect(body)).toEqual([]);
  });
});
