import { defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";

export const manifest = defineManifest<Record<string, never>>()({
  contract: 2,
  identity: {
    accent: "#22c55e",
    category: "ai",
    description:
      "WebMCP draft integration with typed browser tools, input validation, metadata defenses, default-deny policy, audit receipts, lifecycle cleanup, and a spec-shaped test context.",
    docsUrl: "https://github.com/absolutejs/webmcp",
    name: "@absolutejs/webmcp",
    tagline:
      "Make every AbsoluteJS page directly actionable by browser agents.",
  },
  settings: Type.Object({}),
  wiring: [],
});
