import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "../agent.ts";
import { Markdown } from "./Markdown.tsx";
import { AgentStatus, type ToolStep } from "./AgentStatus.tsx";
import { readEventStream } from "./stream.ts";

// The two frame types the server adds on top of the agent's own events —
// `AgentEvent` is imported as a type only, so this stays in lockstep with
// agent.ts without pulling any server code into the browser bundle.
type ChatStreamEvent =
  | AgentEvent
  | { type: "done"; answer: string; iterations: number }
  | { type: "error"; message: string };

interface Message {
  role: "user" | "assistant";
  text: string;
  steps?: ToolStep[];
  /** Between the last tool call and the first answer token — see AgentStatus. */
  preparing?: boolean;
  streaming?: boolean;
  error?: string;
  /** When this message was created — the timer's zero point. */
  startedAt: number;
  /** Set once on done/error; freezes the timer. */
  finishedAt?: number;
}

const EXAMPLES = [
  "Compare Acme and Globex and tell me which one appears to be growing faster.",
  "What are the biggest risks Umbrella Health flags in its filings?",
  "How is Initech's subscription transition going?",
  "Which company in the universe is growing fastest?",
];

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  // Drives the live timer: ticks while a query is in flight, frozen (via
  // each message's own finishedAt) once it's done.
  const [now, setNow] = useState(() => Date.now());

  const bottomRef = useRef<HTMLDivElement>(null);

  // Deltas arrive far faster than React should re-render for — Markdown
  // re-parses the whole answer on every render. Batch them and flush at
  // most once per frame regardless of token rate.
  const pendingDeltaRef = useRef("");
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  });

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [busy]);

  function updateLastMessage(updater: (message: Message) => Message) {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      next[next.length - 1] = updater(next[next.length - 1]);
      return next;
    });
  }

  function flushDelta() {
    rafRef.current = null;
    const text = pendingDeltaRef.current;
    if (!text) return;
    pendingDeltaRef.current = "";
    updateLastMessage((message) => ({ ...message, text: message.text + text }));
  }

  function queueDelta(text: string) {
    pendingDeltaRef.current += text;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flushDelta);
    }
  }

  function applyEvent(event: ChatStreamEvent) {
    switch (event.type) {
      case "iteration":
        // Not the very first iteration (there are already steps to show) —
        // the agent is between tool calls or wrapping up. "Preparing
        // response" until we learn which (a new tool_start, if not).
        updateLastMessage((message) =>
          (message.steps?.length ?? 0) > 0 ? { ...message, preparing: true } : message,
        );
        break;

      case "tool_start":
        updateLastMessage((message) => ({
          ...message,
          preparing: false,
          steps: [...(message.steps ?? []), { id: event.id, label: event.label, status: "running" }],
        }));
        break;

      case "tool_end":
        // tool_end always fires, even after a tool_failed for the same call —
        // don't let it downgrade an already-failed step back to "done".
        updateLastMessage((message) => ({
          ...message,
          steps: (message.steps ?? []).map((step) =>
            step.id === event.id
              ? { ...step, ms: event.ms, status: step.status === "failed" ? "failed" : "done" }
              : step,
          ),
        }));
        break;

      case "tool_failed":
        updateLastMessage((message) => ({
          ...message,
          steps: (message.steps ?? []).map((step) =>
            step.id === event.id ? { ...step, status: "failed" } : step,
          ),
        }));
        break;

      case "answer_start":
        updateLastMessage((message) => ({ ...message, preparing: true }));
        break;

      case "answer_delta":
        queueDelta(event.text);
        break;

      case "done":
        flushDelta();
        updateLastMessage((message) => ({
          ...message,
          text: event.answer,
          streaming: false,
          preparing: false,
          finishedAt: Date.now(),
        }));
        break;

      case "error":
        flushDelta();
        updateLastMessage((message) => ({
          ...message,
          streaming: false,
          preparing: false,
          error: event.message,
          finishedAt: Date.now(),
        }));
        break;
    }
  }

  async function send(question: string) {
    if (!question.trim() || busy) return;

    // Set from the same instant as the messages below, in this same
    // synchronous batch — otherwise the first paint after sending can use
    // `now`'s stale pre-mount value (only the busy-triggered effect refreshes
    // it, and that runs after this commits), showing a negative elapsed time.
    const startedAt = Date.now();
    setNow(startedAt);
    setMessages((prev) => [
      ...prev,
      { role: "user", text: question, startedAt },
      { role: "assistant", text: "", steps: [], streaming: true, startedAt },
    ]);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        updateLastMessage((message) => ({
          ...message,
          streaming: false,
          error: data?.error ?? `Request failed (${res.status})`,
          finishedAt: Date.now(),
        }));
        return;
      }

      for await (const event of readEventStream(res.body)) {
        applyEvent(event as ChatStreamEvent);
      }
    } catch (err) {
      flushDelta();
      updateLastMessage((message) => ({
        ...message,
        streaming: false,
        error: `Something went wrong: ${String(err)}`,
        finishedAt: Date.now(),
      }));
    }

    setBusy(false);
  }

  return (
    <div className="app">
      <header>
        <h1>Rogo Research</h1>
        <p>Ask a question about a company in our coverage universe.</p>
      </header>

      <div className="transcript">
        {messages.length === 0 && (
          <div className="examples">
            {EXAMPLES.map((example) => (
              <button key={example} onClick={() => send(example)}>
                {example}
              </button>
            ))}
          </div>
        )}

        {messages.map((message, i) => (
          <div key={i} className={`bubble ${message.role}`}>
            {message.role === "assistant" ? (
              <>
                <AgentStatus
                  steps={message.steps ?? []}
                  preparing={message.preparing ?? false}
                  hasOutput={message.text.length > 0 || Boolean(message.error)}
                  elapsedSeconds={((message.finishedAt ?? now) - message.startedAt) / 1000}
                />
                <Markdown>{message.text}</Markdown>
                {message.streaming && message.text.length > 0 && <span className="caret" />}
                {message.error && <div className="error-text">{message.error}</div>}
              </>
            ) : (
              message.text
            )}
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a research question…"
          disabled={busy}
        />
        <button type="submit" disabled={busy}>
          Send
        </button>
      </form>
    </div>
  );
}
