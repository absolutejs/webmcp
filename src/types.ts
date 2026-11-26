import type { WebMcpEffectCatalog } from "./effects";
import type { Static, TSchema } from "@sinclair/typebox";

export type WebMcpAnnotations = {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
};

export type WebMcpTool<
  Schema extends TSchema = TSchema,
  Output = unknown,
  Result extends TSchema = TSchema,
> = {
  annotations?: WebMcpAnnotations;
  description: string;
  outputSchema?: Result;
  execute: (
    input: Static<Schema>,
    options: { signal: AbortSignal },
  ) => Promise<Output> | Output;
  inputSchema: Schema;
  name: string;
  title?: string;
};

export type WebMcpNativeTool = {
  annotations?: WebMcpAnnotations;
  description: string;
  outputSchema?: object;
  execute: (
    input: object,
    options?: { signal: AbortSignal },
  ) => Promise<unknown>;
  inputSchema?: object;
  name: string;
  title?: string;
};

export type WebMcpDiscoveredTool = {
  name: string;
  origin?: string;
  source?: Window | null;
};

export type WebMcpCoverageReport = {
  discovery: "available" | "unavailable";
  registered: string[];
  visible: Array<{
    name: string;
    origin?: string;
    coverage: "registered" | "outside-registry" | "unverified";
  }>;
};

export type WebMcpModelContext = EventTarget & {
  getTools?: () =>
    readonly WebMcpDiscoveredTool[] | Promise<readonly WebMcpDiscoveredTool[]>;
  waitForToolsUntil?: (ready: Promise<unknown>) => void;
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
  outcome: "success" | "denied" | "approval-required" | "cancelled" | "error";
  startedAt: string;
  toolName: string;
};

export type WebMcpRegistryOptions = {
  effectCatalog?: WebMcpEffectCatalog;
  allowUnreviewed?: boolean;
  authorize?: (request: {
    annotations: WebMcpAnnotations;
    input: object;
    inputHash: string;
    signal: AbortSignal;
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
