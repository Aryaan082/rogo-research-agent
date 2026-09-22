/**
 * The research agent: a tool-use loop over the mocked research tools.
 */

import Anthropic from "@anthropic-ai/sdk";
import { companies } from "./data.ts";
import { createToolRunner, describeToolCall, toolSchemas, type ToolRunner } from "./tools.ts";

const MODEL = process.env.ROGO_MODEL ?? "claude-sonnet-5";
const MAX_ITERATIONS = 12;

const client = new Anthropic();

const SYSTEM_PROMPT = `You are Rogo Research, an assistant that answers questions about companies for financial analysts.

Use the tools to look up companies, profiles, financials and source documents. Answer the analyst's question.

Our coverage universe:
${companies
  .map(
    (c) =>
      `- ${c.name} (${c.ticker}) — ${c.sector}, HQ ${c.hq}, ${c.employees} employees. ${c.description}`,
  )
  .join("\n")}
`;

const EDITOR_PROMPT = `You are an editor. Rewrite the analyst's draft answer so that it reads clearly and is easy to follow. Keep it brief and conversational. Return only the rewritten answer.`;

export type AgentEvent =
  | { type: "iteration"; n: number }
  | { type: "tool_start"; id: string; name: string; input: unknown; label: string }
  | { type: "tool_end"; id: string; name: string; ms: number; cached: boolean }
  | { type: "tool_failed"; id: string; name: string; message: string }
  | { type: "answer_start" }
  | { type: "answer_delta"; text: string };

export interface AgentResult {
  answer: string;
  iterations: number;
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Runs every tool call from one model turn concurrently.
 *
 * The calls the model asks for in a single turn are independent of each other —
 * it decided on all of them before seeing any of their results — so there is
 * nothing to gain by making them wait in line. Each tool stands in for a
 * network round trip, so running them together costs an iteration about as
 * much as its slowest call instead of the sum of all of them.
 *
 * Errors are caught per call, so one failing tool can't reject the batch or
 * throw away results its siblings already paid for. `Promise.all` keeps the
 * results in `toolUses` order, which is the order the model expects them in.
 */
export async function runToolBatch(
  toolUses: Anthropic.ToolUseBlock[],
  run: ToolRunner,
  onEvent: (event: AgentEvent) => void,
): Promise<Anthropic.ToolResultBlockParam[]> {
  return Promise.all(
    toolUses.map(async (use) => {
      const startedAt = Date.now();
      const input = use.input as Record<string, unknown>;
      const label = describeToolCall(use.name, input);
      onEvent({ type: "tool_start", id: use.id, name: use.name, input: use.input, label });

      // Started before the first await, so duplicates within this same batch
      // find the earlier call already in flight and coalesce onto it.
      const { result, cached } = run(use.name, input);

      let content: string;
      try {
        content = JSON.stringify(await result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        content = `${use.name} returned: ${message}`;
        onEvent({ type: "tool_failed", id: use.id, name: use.name, message });
      }

      onEvent({ type: "tool_end", id: use.id, name: use.name, ms: Date.now() - startedAt, cached });

      return {
        type: "tool_result",
        tool_use_id: use.id,
        content,
      } satisfies Anthropic.ToolResultBlockParam;
    }),
  );
}

export async function runAgent(
  question: string,
  onEvent: (event: AgentEvent) => void,
): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];

  // Scoped to this question: the agent re-researches from scratch each time,
  // so a repeated lookup within one question is the only kind worth reusing.
  const run = createToolRunner();

  let draft = "";
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    onEvent({ type: "iteration", n: iterations });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: toolSchemas,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUses.length === 0) {
      draft = textOf(response);
      break;
    }

    messages.push({
      role: "user",
      content: await runToolBatch(toolUses, run, onEvent),
    });
  }

  if (!draft) {
    draft =
      "I looked at a number of sources but ran out of research steps before I could pull the answer together. Try asking a narrower question.";
  }

  onEvent({ type: "answer_start" });

  // Polish the draft before showing it to the analyst, streaming it back
  // token by token so the UI can render it as it's generated.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    system: EDITOR_PROMPT,
    messages: [
      {
        role: "user",
        content: `Research transcript:\n${JSON.stringify(messages)}\n\nDraft answer:\n${draft}\n\nRewrite the draft answer.`,
      },
    ],
  });

  stream.on("text", (text) => onEvent({ type: "answer_delta", text }));

  const edited = await stream.finalMessage();

  return { answer: textOf(edited), iterations };
}
