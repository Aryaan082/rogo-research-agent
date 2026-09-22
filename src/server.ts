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
  const message = String(req.body.message ?? "");
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

  try {
    const result = await runAgent(message, (event) => {
      logEvent(event);
      send(event);
    });

    send({ type: "done", answer: result.answer, iterations: result.iterations });
  } catch (err) {
    console.error(err);
    send({
      type: "error",
      message: "The research agent failed to answer. Please try again.",
    });
  } finally {
    res.end();
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Agent server listening on http://localhost:${port}`);
});
