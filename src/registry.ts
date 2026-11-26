import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createHash } from "./stable";
import type {
  WebMcpAuditReceipt,
  WebMcpCoverageReport,
  WebMcpNativeTool,
  WebMcpModelContext,
  WebMcpRegistrationOptions,
  WebMcpRegistryOptions,
  WebMcpTool,
} from "./types";
import {
  assertWebMcpInput,
  lintWebMcpMetadata,
  validateWebMcpOrigins,
  validateWebMcpTool,
  WebMcpValidationError,
} from "./validate";

export class WebMcpUnavailableError extends Error {
  constructor() {
    super("WebMCP is unavailable: document.modelContext is not supported");
    this.name = "WebMcpUnavailableError";
  }
}

export class WebMcpAuthorizationError extends Error {
  constructor(
    message: string,
    readonly details: {
      actionId?: string;
      kind: "denied" | "approval-required" | "authorization-missing";
      toolName: string;
    },
  ) {
    super(message);
    this.name = "WebMcpAuthorizationError";
  }
}

const jsonText = (value: unknown, label: string): string | undefined => {
  try {
    return JSON.stringify(value);
  } catch {
    throw new WebMcpValidationError(`${label} must be JSON serializable`);
  }
};

// Settle the invocation even when an application callback is still waiting for approval.
const withCancellation = async <T>(
  signal: AbortSignal,
  run: () => T | Promise<T>,
) => {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([
      cancelled.promise,
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return run();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

const nativeContext = (): WebMcpModelContext | undefined => {
  if (typeof document === "undefined") return undefined;
  return (document as Document & { modelContext?: WebMcpModelContext })
    .modelContext;
};

export const isWebMcpAvailable = () => nativeContext() !== undefined;

export const createWebMcpRegistry = (options: WebMcpRegistryOptions = {}) => {
  const modelContext = options.modelContext ?? nativeContext();
  if (!modelContext) throw new WebMcpUnavailableError();
  const controllers = new Set<AbortController>();

  const registered = new Map<string, WebMcpNativeTool>();
  const ownerWindow =
    modelContext === nativeContext() ? document.defaultView : null;

  const inspectCoverage = async (): Promise<WebMcpCoverageReport> => {
    const snapshot = new Map(registered);
    const names = [...snapshot.keys()];
    if (!modelContext.getTools)
      return { discovery: "unavailable", registered: names, visible: [] };
    const tools = await modelContext.getTools();
    const visible = tools.map((tool) => {
      const entry = snapshot.get(tool.name);
      let coverage: WebMcpCoverageReport["visible"][number]["coverage"] =
        "unverified";
      if (ownerWindow && tool.source && tool.source !== ownerWindow)
        coverage = "outside-registry";
      else if (entry === registered.get(tool.name)) {
        if (!entry) coverage = "outside-registry";
        else if (entry === tool || (ownerWindow && tool.source === ownerWindow))
          coverage = "registered";
      }
      return {
        name: tool.name,
        ...(tool.origin ? { origin: tool.origin } : {}),
        coverage,
      };
    });
    return { discovery: "available", registered: names, visible };
  };

  const changes = new EventTarget();
  const watches = new Set<() => void>();
  const watchCoverage = (
    listener: (
      update: WebMcpCoverageReport | { discovery: "error"; error: unknown },
    ) => void,
  ) => {
    let revision = 0;
    let queued = false;
    let active = true;
    const refresh = () => {
      ++revision;
      if (queued) return;
      queued = true;
      queueMicrotask(async () => {
        queued = false;
        if (!active) return;
        const current = revision;
        let update: Parameters<typeof listener>[0];
        try {
          update = await inspectCoverage();
        } catch (error) {
          update = { discovery: "error", error };
        }
        if (active && current === revision) listener(update);
      });
    };
    const stop = () => {
      active = false;
      changes.removeEventListener("change", refresh);
      modelContext.removeEventListener("toolchange", refresh);
      watches.delete(stop);
    };
    changes.addEventListener("change", refresh);
    modelContext.addEventListener("toolchange", refresh);
    watches.add(stop);
    refresh();
    return stop;
  };

  const register = async <
    Schema extends TSchema,
    Result extends TSchema = TSchema,
  >(
    tool: WebMcpTool<Schema, Static<NoInfer<Result>>, Result>,
    registration: WebMcpRegistrationOptions = {},
  ) => {
    const annotations =
      tool.annotations && Object.freeze({ ...tool.annotations });
    options.effectCatalog?.check({ name: tool.name, annotations });
    validateWebMcpTool(tool, options);
    validateWebMcpOrigins(registration);
    const warnings = lintWebMcpMetadata(tool);
    if (warnings.length > 0) {
      options.onMetadataWarning?.(warnings, tool.name);
      if ((options.metadataPolicy ?? "reject") === "reject")
        throw new WebMcpValidationError(
          `WebMCP metadata rejected: ${warnings.join("; ")}`,
        );
    }
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort(registration.signal?.reason);
    const registrationName = tool.name;
    let nativeTool: WebMcpNativeTool;
    const cleanup = () => {
      if (nativeTool && registered.get(registrationName) === nativeTool) {
        registered.delete(registrationName);
        changes.dispatchEvent(new Event("change"));
      }
      controllers.delete(controller);
      registration.signal?.removeEventListener("abort", abort);
    };
    controller.signal.addEventListener("abort", cleanup, { once: true });
    registration.signal?.addEventListener("abort", abort, { once: true });
    if (registration.signal?.aborted) abort();
    try {
      nativeTool = {
        annotations,
        description: tool.description,
        execute: async (candidate, invocation) => {
          const signal = invocation?.signal
            ? AbortSignal.any([invocation.signal, controller.signal])
            : controller.signal;
          const started = Date.now();
          const startedAt = new Date(started).toISOString();
          let outcome: WebMcpAuditReceipt["outcome"] = "error";
          let actionId: string | undefined;
          let inputHash = "";
          try {
            signal.throwIfAborted();
            const input = assertWebMcpInput(
              tool.inputSchema,
              structuredClone(candidate),
            );
            if (
              new TextEncoder().encode(jsonText(input, "WebMCP tool input"))
                .byteLength > (options.maxInputBytes ?? 256_000)
            )
              throw new WebMcpValidationError("WebMCP tool input is too large");
            inputHash = await createHash(input);
            if (!options.authorize && options.allowUnreviewed !== true) {
              outcome = "denied";
              throw new WebMcpAuthorizationError(
                "WebMCP execution requires an authorization policy",
                { kind: "authorization-missing", toolName: registrationName },
              );
            }
            signal.throwIfAborted();
            const authorize = options.authorize;
            const decision =
              authorize &&
              (await withCancellation(signal, () =>
                authorize({
                  annotations: annotations ?? {},
                  input: structuredClone(input),
                  inputHash,
                  name: registrationName,
                  signal,
                }),
              ));
            signal.throwIfAborted();
            if (options.authorize && decision?.kind !== "allow") {
              if (decision?.kind === "approval-required") {
                actionId = decision.actionId;
                outcome = "approval-required";
                throw new WebMcpAuthorizationError(
                  decision.reason ?? "Approval required",
                  {
                    actionId: decision.actionId,
                    kind: "approval-required",
                    toolName: registrationName,
                  },
                );
              }
              outcome = "denied";
              throw new WebMcpAuthorizationError(
                decision?.kind === "deny"
                  ? decision.reason
                  : "Authorization policy returned no decision",
                { kind: "denied", toolName: registrationName },
              );
            }
            const output = await withCancellation(signal, () =>
              tool.execute(input as never, { signal }),
            );
            signal.throwIfAborted();
            const serialized = jsonText(output, "WebMCP tool output");
            if (
              new TextEncoder().encode(serialized).byteLength >
              (options.maxOutputBytes ?? 1_000_000)
            )
              throw new WebMcpValidationError(
                "WebMCP tool output is too large",
              );
            const result =
              tool.outputSchema && serialized !== undefined
                ? JSON.parse(serialized)
                : output;
            if (tool.outputSchema && !Value.Check(tool.outputSchema, result))
              throw new WebMcpValidationError(
                "WebMCP tool output does not match its schema",
              );
            outcome = "success";
            return result;
          } catch (error) {
            if (signal.aborted) outcome = "cancelled";
            throw error;
          } finally {
            const finished = Date.now();
            await options.onAudit?.({
              ...(actionId ? { actionId } : {}),
              durationMs: finished - started,
              finishedAt: new Date(finished).toISOString(),
              inputHash,
              outcome,
              startedAt,
              toolName: registrationName,
            });
          }
        },
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema && { outputSchema: tool.outputSchema }),
        name: registrationName,
        title: tool.title,
      };
      await modelContext.registerTool(nativeTool, {
        ...(registration.exposedTo
          ? { exposedTo: registration.exposedTo }
          : {}),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      registered.set(registrationName, nativeTool);
      changes.dispatchEvent(new Event("change"));
      return () => controller.abort();
    } catch (error) {
      controller.abort();
      throw error;
    }
  };

  const registerAll = async (
    tools: WebMcpTool<any, any>[],
    registration?: WebMcpRegistrationOptions,
  ) => {
    const disposers: Array<() => void> = [];
    try {
      registration?.signal?.throwIfAborted();
      if (options.effectCatalog) {
        for (const tool of tools) options.effectCatalog.check(tool);
      }
      for (const tool of tools)
        disposers.push(await register(tool, registration));
      return () => disposers.forEach((dispose) => dispose());
    } catch (error) {
      disposers.forEach((dispose) => dispose());
      throw error;
    }
  };

  return {
    dispose: () => {
      for (const stop of watches) stop();
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
    watchCoverage,
    inspectCoverage,
    register,
    registerAll,
  };
};

export const tryCreateWebMcpRegistry = (
  options: WebMcpRegistryOptions = {},
) => {
  const modelContext = options.modelContext ?? nativeContext();
  if (!modelContext) return undefined;
  return createWebMcpRegistry({ ...options, modelContext });
};
