import type { Static, TSchema } from "@sinclair/typebox";

export type WebMcpAnnotations = {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
};

export type WebMcpTool<Schema extends TSchema = TSchema, Output = unknown> = {
  annotations?: WebMcpAnnotations;
  description: string;
  execute: (input: Static<Schema>) => Promise<Output> | Output;
  inputSchema: Schema;
  name: string;
  title?: string;
};

export type WebMcpNativeTool = {
  annotations?: WebMcpAnnotations;
  description: string;
  execute: (input: object) => Promise<unknown>;
  inputSchema?: object;
  name: string;
  title?: string;
};

export type WebMcpModelContext = EventTarget & {
  ontoolchange: ((event: Event) => unknown) | null;
  registerTool: (
    tool: WebMcpNativeTool,
    options?: { exposedTo?: string[]; signal?: AbortSignal },
  ) => Promise<void>;
};

export type WebMcpAuthorization =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { actionId: string; kind: "approval-required"; reason?: string };

export type WebMcpAuditReceipt = {
  actionId?: string;
  durationMs: number;
  finishedAt: string;
  inputHash: string;
  outcome: "success" | "denied" | "approval-required" | "error";
  startedAt: string;
  toolName: string;
};

export type WebMcpRegistryOptions = {
  allowUnreviewed?: boolean;
  authorize?: (request: {
    annotations: WebMcpAnnotations;
    input: object;
    name: string;
  }) => Promise<WebMcpAuthorization> | WebMcpAuthorization;
  maxDescriptionLength?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  metadataPolicy?: "reject" | "warn";
  modelContext?: WebMcpModelContext;
  onAudit?: (receipt: WebMcpAuditReceipt) => Promise<void> | void;
  onMetadataWarning?: (warnings: string[], toolName: string) => void;
};

export type WebMcpRegistrationOptions = {
  exposedTo?: string[];
  signal?: AbortSignal;
};
