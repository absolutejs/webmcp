import { FormatRegistry, Kind, type TSchema } from "@sinclair/typebox";
import { createWebMcpRegistry } from "./registry";
import type {
  WebMcpAnnotations,
  WebMcpAuditReceipt,
  WebMcpModelContext,
  WebMcpTool,
} from "./types";
import { validateWebMcpTool, WebMcpValidationError } from "./validate";

const DEFAULT_MAX_DOCUMENT_BYTES = 256_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TOOLS = 128;
const JSON_MEDIA_TYPE = "application/json";
const TYPEBOX_KIND = "x-absolutejs-typebox-kind";

export type WebMcpHttpActionDescriptor = {
  annotations?: WebMcpAnnotations;
  description: string;
  inputSchema: TSchema;
  name: string;
  title?: string;
};

export type WebMcpHttpProjectionDocument = {
  tools: WebMcpHttpActionDescriptor[];
  version: 1;
};

export type WebMcpHttpFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class WebMcpHttpError extends Error {
  constructor(
    message: string,
    readonly details: {
      kind:
        | "cross-origin"
        | "document-invalid"
        | "http-error"
        | "response-invalid"
        | "response-too-large";
      status?: number;
    },
  ) {
    super(message);
    this.name = "WebMcpHttpError";
  }
}

const browserOrigin = (provided?: string) => {
  const candidate = provided ?? globalThis.location?.origin;
  if (!candidate)
    throw new WebMcpHttpError("A browser origin is required", {
      kind: "cross-origin",
    });
  const url = new URL(candidate);
  if (
    url.origin !== candidate ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      ))
  )
    throw new WebMcpHttpError(
      "WebMCP HTTP actions require an exact trustworthy browser origin",
      { kind: "cross-origin" },
    );

  return url.origin;
};

const sameOriginUrl = (path: string, origin: string) => {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new WebMcpHttpError("WebMCP HTTP paths must be origin-relative", {
      kind: "cross-origin",
    });
  const url = new URL(path, `${origin}/`);
  if (url.origin !== origin)
    throw new WebMcpHttpError("WebMCP HTTP paths must remain same-origin", {
      kind: "cross-origin",
    });

  return url;
};

const sameOriginActionBase = (path: string, origin: string) => {
  const url = sameOriginUrl(path, origin);
  if (!url.pathname.endsWith("/") || url.search || url.hash)
    throw new WebMcpHttpError(
      "WebMCP action base paths must end in / without a query or fragment",
      { kind: "cross-origin" },
    );

  return url;
};

const boundedText = async (
  response: Response,
  maximumBytes: number,
  label: string,
) => {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes)
    throw new WebMcpHttpError(`${label} is too large`, {
      kind: "response-too-large",
      status: response.status,
    });
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new WebMcpHttpError(`${label} is too large`, {
        kind: "response-too-large",
        status: response.status,
      });
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(joined);
};

const jsonResponse = async (
  response: Response,
  maximumBytes: number,
  label: string,
) => {
  if (!response.ok)
    throw new WebMcpHttpError(
      `${label} failed with status ${response.status}`,
      {
        kind: "http-error",
        status: response.status,
      },
    );
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes(JSON_MEDIA_TYPE)
  )
    throw new WebMcpHttpError(`${label} must return JSON`, {
      kind: "response-invalid",
      status: response.status,
    });
  const source = await boundedText(response, maximumBytes, label);
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new WebMcpHttpError(`${label} returned invalid JSON`, {
      kind: "response-invalid",
      status: response.status,
    });
  }
};

const serializedSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(serializedSchema);
  if (typeof value !== "object" || value === null) return value;
  const schema = value as Record<PropertyKey, unknown>;

  return Object.fromEntries([
    ...Object.entries(schema).map(([key, item]) => [
      key,
      serializedSchema(item),
    ]),
    ...(typeof schema[Kind] === "string" ? [[TYPEBOX_KIND, schema[Kind]]] : []),
  ]);
};

const runtimeSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(runtimeSchema);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const kind = source[TYPEBOX_KIND];
  const entries = Object.entries(source)
    .filter(([key]) => key !== TYPEBOX_KIND)
    .map(([key, item]) => [key, runtimeSchema(item)]);

  return {
    ...Object.fromEntries(entries),
    ...(typeof kind === "string" ? { [Kind]: kind } : {}),
  };
};

const validateTools = (tools: WebMcpHttpActionDescriptor[]) => {
  if (tools.length > MAX_TOOLS)
    throw new WebMcpHttpError("WebMCP projection document is invalid", {
      kind: "document-invalid",
    });
  const names = new Set<string>();
  for (const tool of tools) {
    try {
      validateWebMcpTool({ ...tool, execute: () => undefined });
    } catch (error) {
      throw new WebMcpHttpError(
        error instanceof Error ? error.message : "WebMCP tool is invalid",
        { kind: "document-invalid" },
      );
    }
    if (names.has(tool.name))
      throw new WebMcpHttpError(`Duplicate WebMCP tool name: ${tool.name}`, {
        kind: "document-invalid",
      });
    names.add(tool.name);
  }

  return tools;
};

const projectionDocument = (candidate: unknown) => {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  )
    throw new WebMcpHttpError("WebMCP projection document must be an object", {
      kind: "document-invalid",
    });
  const document = candidate as Partial<WebMcpHttpProjectionDocument>;
  if (
    document.version !== 1 ||
    !Array.isArray(document.tools) ||
    document.tools.length > MAX_TOOLS
  )
    throw new WebMcpHttpError("WebMCP projection document is invalid", {
      kind: "document-invalid",
    });
  const tools = document.tools.map((tool) => ({
    ...tool,
    inputSchema: runtimeSchema(tool.inputSchema) as TSchema,
  }));

  return { tools: validateTools(tools), version: 1 };
};

export const createWebMcpHttpProjectionDocument = (
  tools: WebMcpHttpActionDescriptor[],
): WebMcpHttpProjectionDocument => ({
  tools: validateTools(tools).map((tool) => ({
    ...tool,
    inputSchema: serializedSchema(tool.inputSchema) as TSchema,
  })),
  version: 1,
});

export const createWebMcpHttpActionTools = (options: {
  actionBasePath: string;
  fetch?: WebMcpHttpFetch;
  maxResponseBytes?: number;
  origin?: string;
  tools: WebMcpHttpActionDescriptor[];
}): WebMcpTool[] => {
  const origin = browserOrigin(options.origin);
  const base = sameOriginActionBase(options.actionBasePath, origin);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher)
    throw new WebMcpValidationError("WebMCP HTTP actions require fetch");
  const tools = validateTools(options.tools);

  return tools.map((descriptor) => ({
    ...descriptor,
    execute: async (input) => {
      const response = await fetcher(
        new URL(encodeURIComponent(descriptor.name), base),
        {
          body: JSON.stringify(input),
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            accept: JSON_MEDIA_TYPE,
            "content-type": JSON_MEDIA_TYPE,
          },
          method: "POST",
          redirect: "error",
        },
      );

      return jsonResponse(
        response,
        options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        `WebMCP action ${descriptor.name}`,
      );
    },
  }));
};

export const bootstrapWebMcpHttpActions = async (options: {
  actionBasePath: string;
  fetch?: WebMcpHttpFetch;
  manifestPath: string;
  maxDocumentBytes?: number;
  maxResponseBytes?: number;
  modelContext?: WebMcpModelContext;
  onAudit?: (receipt: WebMcpAuditReceipt) => Promise<void> | void;
  origin?: string;
  formats?: Record<string, (value: string) => boolean>;
}) => {
  const origin = browserOrigin(options.origin);
  const manifestUrl = sameOriginUrl(options.manifestPath, origin);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher)
    throw new WebMcpValidationError("WebMCP HTTP bootstrap requires fetch");
  const response = await fetcher(manifestUrl, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: JSON_MEDIA_TYPE },
    method: "GET",
    redirect: "error",
  });
  const document = projectionDocument(
    await jsonResponse(
      response,
      options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
      "WebMCP projection document",
    ),
  );
  for (const [name, check] of Object.entries(options.formats ?? {}))
    if (!FormatRegistry.Has(name)) FormatRegistry.Set(name, check);
  const tools = createWebMcpHttpActionTools({
    actionBasePath: options.actionBasePath,
    fetch: fetcher,
    maxResponseBytes: options.maxResponseBytes,
    origin,
    tools: document.tools,
  });
  const registry = createWebMcpRegistry({
    allowUnreviewed: true,
    maxOutputBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    modelContext: options.modelContext,
    onAudit: options.onAudit,
  });
  const dispose = await registry.registerAll(tools);

  return {
    dispose: () => {
      dispose();
      registry.dispose();
    },
    toolNames: tools.map(({ name }) => name),
  };
};
