export interface ToolStep {
  id: string;
  label: string;
  status: "running" | "done" | "failed";
  ms?: number;
  /** Served from an earlier identical call in this question rather than re-run. */
  cached?: boolean;
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
 *   nothing yet            → "Thinking… · 0s"
 *   one tool is running    → "Fetching financials for Acme Corp · 1s"
 *   several are running    → "3 lookups running · 1s" — a whole turn's calls
 *                            go out at once, and naming any one of them would
 *                            mean showing a call that may already have
 *                            finished while its siblings are still in flight.
 *                            As the batch drains to its last call, the line
 *                            narrows back to that call's own label.
 *   none running (between
 *   calls, or after the
 *   last one)              → the most recent label, until the next call
 *                            starts; then "Preparing response… · 4s"
 *   output has started     → collapses to "3 tool calls · 5s" (or
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

  const elapsed = `${Math.floor(elapsedSeconds)}s`;
  const failed = steps.filter((s) => s.status === "failed").length;
  const running = steps.filter((s) => s.status === "running");

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
  } else if (running.length > 1) {
    // A batch is in flight. No single label is the honest one, and picking the
    // newest would let the line show a finished call while others still run.
    dotClass = "running";
    label = `${running.length} lookups running · ${elapsed}`;
  } else if (running.length === 1) {
    // Either an ordinary single call, or a batch drained down to its straggler.
    dotClass = "running";
    label = `${running[0].label} · ${elapsed}`;
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
            {step.cached ? (
              <span className="ms">cached</span>
            ) : (
              step.ms !== undefined && <span className="ms">{step.ms}ms</span>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
