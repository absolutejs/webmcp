import type { WebMcpAnnotations } from "./types";
import { WebMcpValidationError } from "./validate";

export type WebMcpCatalogAction = {
  transportName: string;
  risk: string;
  authorization: { effects?: readonly string[]; approval?: string };
};

export const createWebMcpEffectCatalog = (
  actions: readonly WebMcpCatalogAction[],
) => {
  const entries = new Map<
    string,
    { readOnly: boolean; requiresApproval: boolean; effects: readonly string[] }
  >();
  for (const { transportName, risk, authorization } of actions) {
    const effects = authorization.effects;
    if (
      !transportName ||
      !risk ||
      !effects?.length ||
      effects.some((effect) => !effect.trim()) ||
      entries.has(transportName)
    )
      throw new WebMcpValidationError(
        "Catalog actions need a unique transport name, risk and explicit effects",
      );
    const readOnly =
      risk === "R0" && effects.length === 1 && effects[0] === "read";
    entries.set(
      transportName,
      Object.freeze({
        readOnly,
        requiresApproval:
          !readOnly ||
          (authorization.approval !== undefined &&
            authorization.approval !== "never"),
        effects: Object.freeze([...effects]),
      }),
    );
  }
  const check = (tool: { name: string; annotations?: WebMcpAnnotations }) => {
    const entry = entries.get(tool.name);
    if (!entry)
      throw new WebMcpValidationError(
        "WebMCP tool is absent from the trusted effect catalog",
      );
    const readOnlyHint = tool.annotations?.readOnlyHint;
    if (readOnlyHint !== undefined && typeof readOnlyHint !== "boolean")
      throw new WebMcpValidationError(
        "WebMCP read-only hint must be a boolean",
      );
    if (readOnlyHint === true && !entry.readOnly)
      throw new WebMcpValidationError(
        "WebMCP read-only hint conflicts with the trusted effect catalog",
      );
    return entry;
  };
  return { check };
};
export type WebMcpEffectCatalog = ReturnType<typeof createWebMcpEffectCatalog>;
