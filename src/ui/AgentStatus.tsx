export interface ToolStep {
  id: string;
  label: string;
  status: "running" | "done" | "failed";
  ms?: number;
}

interface AgentStatusProps {
  steps: ToolStep[];
  /** Between the last tool call and the first answer token — an invisible
   *  drafting pass plus the editor's own time-to-first-token. */
  preparing: boolean;
  /** True once the answer has started arriving (or the request has ended in
   *  error) — the point past which we stop narrating and start summarizing. */
  hasOutput: boolean;
  elapsedSeconds: number;
}

/**
 * The agent's live status for one answer, as a single line at the top of the
 * assistant bubble:
 *
 *   nothing yet            → "Thinking… · 0.8s"
 *   a tool is running      → "Fetching financials for Acme Corp · 1.3s"
 *   a tool just finished   → same label, stays until a new one starts — we
 *                            never show a count while more calls could still
 *                            come in, only ever "whichever is most recent"
 *   between tool calls,
 *   or after the last one  → "Preparing response… · 4.6s"
 *   output has started     → collapses to "3 tool calls · 5.1s" (or
 *                            "· 1 failed"), a permanent record of what was
 *                            consulted
 *
 * The timer is supplied by the caller as elapsedSeconds, ticking from the
 * moment the question was sent until the answer is fully done.
 *
 * The wrapper element (<details> vs a plain line) is chosen only by whether
 * there's anything to expand (steps.length), independent of which phase's
 * label is showing — so once a call has run, the element never remounts and
 * an analyst who expanded it to watch progress keeps that view through
 * "preparing" and into the final collapsed summary, instead of it resetting
 * out from under them.
 */
export function AgentStatus({ steps, preparing, hasOutput, elapsedSeconds }: AgentStatusProps) {
  if (hasOutput && steps.length === 0) return null;

  const elapsed = `${elapsedSeconds.toFixed(1)}s`;
  const failed = steps.filter((s) => s.status === "failed").length;

  let dotClass: string;
  let label: string;

  if (hasOutput) {
    dotClass = failed > 0 ? "failed" : "done";
    label =
      `${steps.length} tool call${steps.length === 1 ? "" : "s"} · ` +
      (failed > 0 ? `${failed} failed` : elapsed);
  } else if (preparing) {
    dotClass = "running";
    label = `Preparing response… · ${elapsed}`;
  } else if (steps.length > 0) {
    const current = steps[steps.length - 1];
    dotClass = current.status;
    label = `${current.label} · ${elapsed}`;
  } else {
    dotClass = "running";
    label = `Thinking… · ${elapsed}`;
  }

  if (steps.length === 0) {
    return (
      <div className="tool-steps status-only">
        <span className={`dot ${dotClass}`} />
        {label}
      </div>
    );
  }

  return (
    <details className="tool-steps">
      <summary>
        <span className={`dot ${dotClass}`} />
        {label}
      </summary>
      <ol>
        {steps.map((step) => (
          <li key={step.id} className={step.status}>
            <span className={`dot ${step.status}`} />
            <span className="label">{step.label}</span>
            {step.ms !== undefined && <span className="ms">{step.ms}ms</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}
