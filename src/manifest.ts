import { defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";

export const manifest = defineManifest<Record<string, never>>()({
  contract: 2,
  discovery: {
    audiences: ["web-applications", "browser-agents"],
    intents: [
      "expose browser actions to agents",
      "authorize WebMCP tools",
      "project same-origin HTTP actions into WebMCP",
      "test WebMCP integrations",
    ],
    keywords: [
      "agents",
      "webmcp",
      "browser",
      "tools",
      "authorization",
      "audit",
    ],
    protocols: ["WebMCP"],
  },
  identity: {
    accent: "#22c55e",
    category: "ai",
    description:
      "WebMCP draft integration with typed browser tools, same-origin HTTP action projection, input validation, metadata defenses, default-deny policy, audit receipts, lifecycle cleanup, and a spec-shaped test context.",
    docsUrl: "https://github.com/absolutejs/webmcp",
    name: "@absolutejs/webmcp",
    tagline:
      "Make every AbsoluteJS page directly actionable by browser agents.",
  },
  integration: {
    description:
      "The host must bind exact origins, authenticated caller context, default-deny authorization, audit receipts, and lifecycle cleanup before registering browser tools.",
    mode: "code-first",
  },
  settings: Type.Object({}),
  wiring: [],
});
