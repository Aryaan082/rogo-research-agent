import "dotenv/config";
import express from "express";
import { runAgent, type AgentEvent } from "./agent.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "\nANTHROPIC_API_KEY is not set.\nCopy .env.example to .env and add your key, then run `npm run dev` again.\n",
  );
  process.exit(1);
}

const app = express();
app.use(express.json());

function logEvent(event: AgentEvent) {
  switch (event.type) {
    case "iteration":
      console.log(`[agent] iteration ${event.n}`);
      break;
    case "tool_start":
      console.log(`[tool]  → ${event.name} ${JSON.stringify(event.input)}`);
      break;
    case "tool_end":
      console.log(`[tool]  ← ${event.name} (${event.ms}ms)`);
      break;
    case "tool_failed":
      console.log(`[tool]  ! ${event.name}: ${event.message}`);
      break;
    case "answer_start":
      console.log(`[agent] streaming answer`);
      break;
    case "answer_delta":
      // token-by-token — too noisy for the terminal, the client renders these
      break;
  }
}

app.post("/api/chat", async (req, res) => {
  const message = String(req.body.message ?? "").trim();
  console.log(`\n[chat] ${message}`);

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // From here on, failures must travel as SSE frames, not HTTP status codes —
  // the 200 + event-stream headers are about to go out.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const controller = new AbortController();
  // `req`'s 'close' event fires as soon as Express finishes reading the
  // request body — effectively immediately, unrelated to the client going
  // away. `res`'s 'close' tracks the response instead, but it also fires
  // after we call res.end() ourselves, so only treat it as a disconnect if
  // we haven't finished writing the response yet.
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const result = await runAgent(
      message,
      (event) => {
        logEvent(event);
        send(event);
      },
      controller.signal,
    );

    send({ type: "done", answer: result.answer, iterations: result.iterations });
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error(err);
      send({
        type: "error",
        message: "The research agent failed to answer. Please try again.",
      });
    }
  } finally {
    res.end();
  }
});

// Deliberately not the generic PORT — vite.config.ts's dev proxy target is
// hardcoded to localhost:8787, and dev tooling that assigns PORT for "the
// one port the user opens" (that's Vite's 5173 here) would otherwise steer
// this internal API server onto the wrong port and silently break the proxy.
const port = Number(process.env.AGENT_PORT ?? 8787);
app.listen(port, () => {
  console.log(`Agent server listening on http://localhost:${port}`);
});
