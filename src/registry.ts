import { createHash } from "./stable";
import type {
  WebMcpAuditReceipt,
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

const byteLength = (value: unknown, label: string) => {
  let source: string;
  try {
    source = JSON.stringify(value);
  } catch {
    throw new WebMcpValidationError(`${label} must be JSON serializable`);
  }
  return new TextEncoder().encode(source).byteLength;
};

const nativeContext = (): WebMcpModelContext | undefined => {
  if (typeof document === "undefined") return undefined;
  return (document as Document & { modelContext?: WebMcpModelContext })
    .modelContext;
};

export const createWebMcpRegistry = (options: WebMcpRegistryOptions = {}) => {
  const modelContext = options.modelContext ?? nativeContext();
  if (!modelContext) throw new WebMcpUnavailableError();
  const controllers = new Set<AbortController>();

  const register = async <Schema extends import("@sinclair/typebox").TSchema>(
    tool: WebMcpTool<Schema>,
    registration: WebMcpRegistrationOptions = {},
  ) => {
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
    const cleanup = () => {
      controllers.delete(controller);
      registration.signal?.removeEventListener("abort", abort);
    };
    controller.signal.addEventListener("abort", cleanup, { once: true });
    registration.signal?.addEventListener("abort", abort, { once: true });
    if (registration.signal?.aborted) abort();
    try {
      await modelContext.registerTool(
        {
          annotations: tool.annotations,
          description: tool.description,
          execute: async (candidate) => {
            const started = Date.now();
            const startedAt = new Date(started).toISOString();
            let outcome: WebMcpAuditReceipt["outcome"] = "error";
            let actionId: string | undefined;
            let inputHash = "";
            try {
              const input = assertWebMcpInput(tool.inputSchema, candidate);
              if (
                byteLength(input, "WebMCP tool input") >
                (options.maxInputBytes ?? 256_000)
              )
                throw new WebMcpValidationError(
                  "WebMCP tool input is too large",
                );
              inputHash = await createHash(input);
              if (!options.authorize && options.allowUnreviewed !== true) {
                outcome = "denied";
                throw new WebMcpAuthorizationError(
                  "WebMCP execution requires an authorization policy",
                  { kind: "authorization-missing", toolName: tool.name },
                );
              }
              const decision = await options.authorize?.({
                annotations: tool.annotations ?? {},
                input: structuredClone(input),
                name: tool.name,
              });
              if (options.authorize && decision?.kind !== "allow") {
                if (decision?.kind === "approval-required") {
                  actionId = decision.actionId;
                  outcome = "approval-required";
                  throw new WebMcpAuthorizationError(
                    decision.reason ?? "Approval required",
                    {
                      actionId: decision.actionId,
                      kind: "approval-required",
                      toolName: tool.name,
                    },
                  );
                }
                outcome = "denied";
                throw new WebMcpAuthorizationError(
                  decision?.kind === "deny"
                    ? decision.reason
                    : "Authorization policy returned no decision",
                  { kind: "denied", toolName: tool.name },
                );
              }
              const output = await tool.execute(input as never);
              if (
                byteLength(output, "WebMCP tool output") >
                (options.maxOutputBytes ?? 1_000_000)
              )
                throw new WebMcpValidationError(
                  "WebMCP tool output is too large",
                );
              outcome = "success";
              return output;
            } finally {
              const finished = Date.now();
              await options.onAudit?.({
                ...(actionId ? { actionId } : {}),
                durationMs: finished - started,
                finishedAt: new Date(finished).toISOString(),
                inputHash,
                outcome,
                startedAt,
                toolName: tool.name,
              });
            }
          },
          inputSchema: tool.inputSchema,
          name: tool.name,
          title: tool.title,
        },
        {
          ...(registration.exposedTo
            ? { exposedTo: registration.exposedTo }
            : {}),
          signal: controller.signal,
        },
      );
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
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
    register,
    registerAll,
  };
};
