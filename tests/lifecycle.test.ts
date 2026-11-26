import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
  bootstrapWebMcpHttpActions,
  createWebMcpHttpProjectionDocument,
  createWebMcpRegistry,
  createWebMcpTestContext,
  type WebMcpCoverageReport,
} from "../src";

const descriptor = {
  name: "project.summary",
  description: "Read a project summary.",
  inputSchema: Type.Object({}),
  outputSchema: Type.Object({ id: Type.String() }),
};
const manifest = createWebMcpHttpProjectionDocument([descriptor]);
const base = {
  actionBasePath: "/api/owner/webmcp/actions/",
  manifestPath: "/api/owner/webmcp",
  origin: "https://example.org",
};

test("cancelling pending approval settles promptly, audits once and skips the handler", async () => {
  const context = createWebMcpTestContext();
  const entered = Promise.withResolvers<AbortSignal>();
  const approval = Promise.withResolvers<{ kind: "allow" }>();
  const outcomes: string[] = [];
  let calls = 0;
  const registry = createWebMcpRegistry({
    modelContext: context,
    authorize: ({ signal }) => {
      entered.resolve(signal);
      return approval.promise;
    },
    onAudit: (receipt) => {
      outcomes.push(receipt.outcome);
    },
  });
  await registry.register({
    ...descriptor,
    execute: () => {
      calls++;
      return { id: "ok" };
    },
  });
  const caller = new AbortController();
  const invocation = context.executeTool(descriptor.name, {}, caller);
  const signal = await entered.promise;
  caller.abort();
  await expect(invocation).rejects.toMatchObject({ name: "AbortError" });
  approval.resolve({ kind: "allow" });
  await Promise.resolve();
  expect(signal.aborted).toBe(true);
  expect(calls).toBe(0);
  expect(outcomes).toEqual(["cancelled"]);
});

test("announces setup synchronously and aborts before mounting any late manifest", async () => {
  const pending = Promise.withResolvers<Response>();
  const controller = new AbortController();
  let ready: Promise<unknown> | undefined;
  const context = Object.assign(createWebMcpTestContext(), {
    waitForToolsUntil(p: Promise<unknown>) {
      ready = p;
    },
  });
  const mount = bootstrapWebMcpHttpActions({
    ...base,
    modelContext: context,
    signal: controller.signal,
    fetch: (_url, init) => {
      expect(init?.signal?.aborted).toBe(false);
      return pending.promise;
    },
  });
  expect(ready).toBeDefined();
  controller.abort();
  pending.resolve(Response.json(manifest));
  await expect(mount).rejects.toMatchObject({ name: "AbortError" });
  await expect(ready!).rejects.toMatchObject({ name: "AbortError" });
  expect(context.getTools()).toEqual([]);
});

test("publishes projected output schemas, rejects malformed results and cancels in-flight HTTP calls", async () => {
  const context = createWebMcpTestContext();
  const started = Promise.withResolvers<AbortSignal>();
  let calls = 0;
  const mounted = await bootstrapWebMcpHttpActions({
    ...base,
    modelContext: context,
    fetch: async (_url, init) => {
      if (init?.method === "GET") return Response.json(manifest);
      if (++calls === 1) return Response.json({ id: 123 });
      const signal = init!.signal!;
      started.resolve(signal);
      return new Promise<Response>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  expect(context.getTools()[0]?.outputSchema).toMatchObject({ type: "object" });
  await expect(context.executeTool(descriptor.name, {})).rejects.toThrow(
    "output does not match",
  );
  const caller = new AbortController();
  const active = context.executeTool(descriptor.name, {}, caller);
  const httpSignal = await started.promise;
  caller.abort();
  await expect(active).rejects.toMatchObject({ name: "AbortError" });
  expect(httpSignal.aborted).toBe(true);
  mounted.dispose();
});

test("coverage subscriptions discard stale discoveries, report errors and stop on disposal", async () => {
  const requests: ReturnType<
    typeof Promise.withResolvers<{ name: string }[]>
  >[] = [];
  const context = Object.assign(new EventTarget(), {
    ontoolchange: null,
    registerTool: async () => {},
    getTools: () => {
      const request = Promise.withResolvers<{ name: string }[]>();
      requests.push(request);
      return request.promise;
    },
  });
  const registry = createWebMcpRegistry({ modelContext: context });
  const updates: Array<
    WebMcpCoverageReport | { discovery: "error"; error: unknown }
  > = [];
  const stop = registry.watchCoverage((update) => updates.push(update));
  await Bun.sleep(0);
  context.dispatchEvent(new Event("toolchange"));
  await Bun.sleep(0);
  requests[1]!.resolve([{ name: "partner" }]);
  requests[0]!.resolve([]);
  await Bun.sleep(0);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    visible: [{ name: "partner", coverage: "outside-registry" }],
  });
  context.dispatchEvent(new Event("toolchange"));
  await Bun.sleep(0);
  requests[2]!.reject(new Error("discovery unavailable"));
  await Bun.sleep(0);
  expect(updates[1]).toMatchObject({ discovery: "error" });
  registry.dispose();
  stop();
  context.dispatchEvent(new Event("toolchange"));
  await Bun.sleep(0);
  expect(requests.length).toBe(3);
});

test("checks the serialized output the agent actually receives", async () => {
  const context = createWebMcpTestContext();
  const registry = createWebMcpRegistry({
    modelContext: context,
    allowUnreviewed: true,
  });
  await registry.register({
    ...descriptor,
    execute: () => ({ id: "project", toJSON: () => ({ id: 100 }) }),
  });
  await expect(context.executeTool(descriptor.name, {})).rejects.toThrow(
    "output does not match",
  );
});
