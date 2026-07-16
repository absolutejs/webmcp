import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { WebMcpRegistrationOptions, WebMcpTool } from "./types";

const NAME = /^[A-Za-z0-9_.-]{1,128}$/u;

export class WebMcpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpValidationError";
  }
}

export const lintWebMcpMetadata = (tool: {
  description: string;
  name: string;
}) => {
  const warnings: string[] = [];
  const description = tool.description.toLowerCase();
  if (/<\/?(?:system|assistant|important|script)/u.test(description))
    warnings.push("description contains instruction-like markup");
  if (
    /ignore (?:all |any )?(?:previous|prior|system) instructions/u.test(
      description,
    )
  )
    warnings.push("description contains an instruction override pattern");
  if (
    /(?:send|upload|reveal|exfiltrate).{0,40}(?:history|secret|credential|cookie)/u.test(
      description,
    )
  )
    warnings.push(
      "description requests potentially unrelated sensitive data movement",
    );
  return warnings;
};

export const validateWebMcpTool = <Schema extends TSchema>(
  tool: WebMcpTool<Schema>,
  options?: { maxDescriptionLength?: number },
) => {
  if (!NAME.test(tool.name))
    throw new WebMcpValidationError(
      "WebMCP tool name must be 1-128 ASCII letters, digits, _, - or .",
    );
  if (tool.description.length === 0)
    throw new WebMcpValidationError("WebMCP tool description is required");
  if (tool.description.length > (options?.maxDescriptionLength ?? 4_096))
    throw new WebMcpValidationError("WebMCP tool description is too long");
  if (typeof tool.execute !== "function")
    throw new WebMcpValidationError("WebMCP tool execute callback is required");
  try {
    JSON.stringify(tool.inputSchema);
  } catch {
    throw new WebMcpValidationError(
      "WebMCP input schema must be JSON serializable",
    );
  }
};

export const validateWebMcpOrigins = (options?: WebMcpRegistrationOptions) => {
  for (const value of options?.exposedTo ?? []) {
    const url = new URL(value);
    const local =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (url.protocol !== "https:" && !local) ||
      url.origin !== value ||
      url.username ||
      url.password
    ) {
      throw new WebMcpValidationError(
        "WebMCP exposedTo entries must be exact trustworthy origins",
      );
    }
  }
};

export const assertWebMcpInput = (schema: TSchema, input: unknown) => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new WebMcpValidationError("WebMCP tool input must be an object");
  if (!Value.Check(schema, input)) {
    const errors = [...Value.Errors(schema, input)]
      .slice(0, 10)
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("; ");
    throw new WebMcpValidationError(`WebMCP tool input is invalid: ${errors}`);
  }
  return input as object;
};
