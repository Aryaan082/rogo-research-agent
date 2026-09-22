/**
 * The research agent: a tool-use loop over the mocked research tools.
 */

import Anthropic from "@anthropic-ai/sdk";
import { companies } from "./data.ts";
import { describeToolCall, executeTool, toolSchemas } from "./tools.ts";

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
  | { type: "tool_end"; id: string; name: string; ms: number }
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

export async function runAgent(
  question: string,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];

  let draft = "";
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    if (signal?.aborted) break;

    iterations++;
    onEvent({ type: "iteration", n: iterations });

    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: toolSchemas,
        messages,
      },
      { signal },
    );

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUses.length === 0) {
      draft = textOf(response);
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const use of toolUses) {
      const startedAt = Date.now();
      const input = use.input as Record<string, unknown>;
      const label = describeToolCall(use.name, input);
      onEvent({ type: "tool_start", id: use.id, name: use.name, input: use.input, label });

      let content: string;
      try {
        const output = await executeTool(use.name, input);
        content = JSON.stringify(output);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        content = `${use.name} returned: ${message}`;
        onEvent({ type: "tool_failed", id: use.id, name: use.name, message });
      }

      onEvent({ type: "tool_end", id: use.id, name: use.name, ms: Date.now() - startedAt });
      toolResults.push({ type: "tool_result", tool_use_id: use.id, content });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // The client disconnected mid-loop — stop instead of spending another
  // (uncounted) model call on an editor pass nobody will read.
  if (signal?.aborted) {
    return { answer: "", iterations };
  }

  if (!draft) {
    draft =
      "I looked at a number of sources but ran out of research steps before I could pull the answer together. Try asking a narrower question.";
  }

  onEvent({ type: "answer_start" });

  // Polish the draft before showing it to the analyst, streaming it back
  // token by token so the UI can render it as it's generated.
  const stream = client.messages.stream(
    {
      model: MODEL,
      max_tokens: 16000,
      system: EDITOR_PROMPT,
      messages: [
        {
          role: "user",
          content: `Research transcript:\n${JSON.stringify(messages)}\n\nDraft answer:\n${draft}\n\nRewrite the draft answer.`,
        },
      ],
    },
    { signal },
  );

  stream.on("text", (text) => onEvent({ type: "answer_delta", text }));

  const edited = await stream.finalMessage();

  return { answer: textOf(edited), iterations };
}
