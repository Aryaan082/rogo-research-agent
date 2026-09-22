import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { runToolBatch, type AgentEvent } from "./agent.ts";
import { createToolRunner } from "./tools.ts";

/** A tool_use block; only the fields runToolBatch reads need to be real. */
function use(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}

/**
 * An executor whose calls are resolved by hand, so "did these run together?"
 * is a question about ordering rather than about elapsed time — a wall-clock
 * threshold would assert the same thing but flake on a loaded machine.
 */
function controllable() {
  const started: string[] = [];
  const settle = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  const execute = (name: string, input: Record<string, unknown>) => {
    started.push(`${name}:${JSON.stringify(input)}`);
    return new Promise<unknown>((resolve, reject) => {
      settle.set(`${name}:${JSON.stringify(input)}`, { resolve, reject });
    });
  };

  return {
    started,
    execute,
    resolve: (key: string, value: unknown) => settle.get(key)!.resolve(value),
    reject: (key: string, error: unknown) => settle.get(key)!.reject(error),
  };
}

/** Lets pending microtasks run, so in-flight coalescing has settled. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runToolBatch", () => {
  it("starts every call in the turn before any of them finishes", async () => {
    const tools = controllable();
    const batch = runToolBatch(
      [
        use("t1", "getFinancials", { company: "Acme Corp" }),
        use("t2", "getCompanyProfile", { company: "Globex" }),
        use("t3", "searchCompanies", { query: "Initech" }),
      ],
      createToolRunner(tools.execute),
      () => {},
    );

    await tick();
    // Nothing has been resolved yet, so a serial loop would be stuck on the first.
    expect(tools.started).toEqual([
      'getFinancials:{"company":"Acme Corp"}',
      'getCompanyProfile:{"company":"Globex"}',
      'searchCompanies:{"query":"Initech"}',
    ]);

    tools.resolve('getFinancials:{"company":"Acme Corp"}', { revenue: 1 });
    tools.resolve('getCompanyProfile:{"company":"Globex"}', { name: "Globex" });
    tools.resolve('searchCompanies:{"query":"Initech"}', []);
    await batch;
  });

  it("returns results in request order, matched to their tool_use ids", async () => {
    const tools = controllable();
    const batch = runToolBatch(
      [
        use("t1", "getFinancials", { company: "Acme Corp" }),
        use("t2", "getCompanyProfile", { company: "Globex" }),
      ],
      createToolRunner(tools.execute),
      () => {},
    );

    await tick();
    // Resolved out of order — the results must still come back in request order.
    tools.resolve('getCompanyProfile:{"company":"Globex"}', { name: "Globex" });
    tools.resolve('getFinancials:{"company":"Acme Corp"}', { revenue: 1 });

    expect(await batch).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: '{"revenue":1}' },
      { type: "tool_result", tool_use_id: "t2", content: '{"name":"Globex"}' },
    ]);
  });

  it("keeps a failing call from taking its siblings down with it", async () => {
    const tools = controllable();
    const events: AgentEvent[] = [];
    const batch = runToolBatch(
      [
        use("t1", "getFinancials", { company: "Nowhere Inc" }),
        use("t2", "getCompanyProfile", { company: "Globex" }),
      ],
      createToolRunner(tools.execute),
      (event) => events.push(event),
    );

    await tick();
    tools.reject('getFinancials:{"company":"Nowhere Inc"}', new Error('no financials found for "Nowhere Inc"'));
    tools.resolve('getCompanyProfile:{"company":"Globex"}', { name: "Globex" });

    const results = await batch;
    expect(results[0].content).toBe('getFinancials returned: no financials found for "Nowhere Inc"');
    expect(results[1].content).toBe('{"name":"Globex"}');

    expect(events).toContainEqual({
      type: "tool_failed",
      id: "t1",
      name: "getFinancials",
      message: 'no financials found for "Nowhere Inc"',
    });
    // tool_end still fires for the failed call, so the UI can stop its spinner.
    expect(events.filter((e) => e.type === "tool_end")).toHaveLength(2);
  });

  it("coalesces a duplicate within one turn onto the call already in flight", async () => {
    const tools = controllable();
    const events: AgentEvent[] = [];
    const batch = runToolBatch(
      [
        use("t1", "getFinancials", { company: "Acme Corp" }),
        use("t2", "getFinancials", { company: "Acme Corp" }),
      ],
      createToolRunner(tools.execute),
      (event) => events.push(event),
    );

    await tick();
    expect(tools.started).toHaveLength(1);

    tools.resolve('getFinancials:{"company":"Acme Corp"}', { revenue: 1 });
    const results = await batch;

    // Both calls still get their own result block, keyed to their own id.
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2"]);
    expect(results[0].content).toBe(results[1].content);
    expect(events.filter((e) => e.type === "tool_end").map((e) => e.cached)).toEqual([false, true]);
  });

  it("treats inputs written in a different key order as the same call", async () => {
    const tools = controllable();
    const batch = runToolBatch(
      [
        use("t1", "searchDocuments", { query: "margin", company: "Acme Corp" }),
        use("t2", "searchDocuments", { company: "Acme Corp", query: "margin" }),
      ],
      createToolRunner(tools.execute),
      () => {},
    );

    await tick();
    expect(tools.started).toHaveLength(1);
    tools.resolve(tools.started[0], []);
    await batch;
  });

  it("serves a repeat in a later turn from the cache", async () => {
    const tools = controllable();
    const run = createToolRunner(tools.execute);
    const events: AgentEvent[] = [];

    const first = runToolBatch([use("t1", "getFinancials", { company: "Acme Corp" })], run, () => {});
    await tick();
    tools.resolve('getFinancials:{"company":"Acme Corp"}', { revenue: 1 });
    await first;

    const second = runToolBatch(
      [use("t2", "getFinancials", { company: "Acme Corp" })],
      run,
      (event) => events.push(event),
    );
    expect(await second).toEqual([
      { type: "tool_result", tool_use_id: "t2", content: '{"revenue":1}' },
    ]);
    expect(tools.started).toHaveLength(1);
    expect(events.find((e) => e.type === "tool_end")?.cached).toBe(true);
  });

  it("shares one rejection with everyone waiting, then lets a later turn retry", async () => {
    const tools = controllable();
    const run = createToolRunner(tools.execute);

    const first = runToolBatch(
      [
        use("t1", "getFinancials", { company: "Nowhere Inc" }),
        use("t2", "getFinancials", { company: "Nowhere Inc" }),
      ],
      run,
      () => {},
    );

    await tick();
    expect(tools.started).toHaveLength(1);
    tools.reject('getFinancials:{"company":"Nowhere Inc"}', new Error("upstream unavailable"));

    const results = await first;
    // Both saw the error; neither paid for a second call to re-derive it.
    expect(results[0].content).toBe("getFinancials returned: upstream unavailable");
    expect(results[1].content).toBe("getFinancials returned: upstream unavailable");
    expect(tools.started).toHaveLength(1);

    // The failure isn't pinned: a later turn gets a fresh attempt.
    await tick();
    const second = runToolBatch([use("t3", "getFinancials", { company: "Nowhere Inc" })], run, () => {});
    await tick();
    expect(tools.started).toHaveLength(2);
    tools.resolve('getFinancials:{"company":"Nowhere Inc"}', { revenue: 2 });
    expect((await second)[0].content).toBe('{"revenue":2}');
  });
});
