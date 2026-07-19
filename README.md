# @absolutejs/webmcp

Secure, typed integration with the current WebMCP draft for browser-native AI
agent actions.

WebMCP lets a page expose structured tools through
`document.modelContext.registerTool()`. AbsoluteJS keeps that standard surface
and adds the controls a production application needs: TypeBox input validation,
default-deny authorization over the exact input, approval IDs, metadata
poisoning checks, bounded payloads, privacy-preserving audit receipts, secure
cross-origin exposure, abort-based cleanup, atomic batch registration, and a
spec-shaped test context.

```ts
import { createWebMcpRegistry } from "@absolutejs/webmcp";
import { Type } from "@sinclair/typebox";

const tools = createWebMcpRegistry({
  authorize: ({ name, input, annotations }) =>
    agencyDecisionFor({ name, input, annotations }),
  onAudit: (receipt) => audit.write(receipt),
});

await tools.register({
  name: "support.create",
  title: "Create support ticket",
  description: "Create a support ticket after the user confirms the request.",
  inputSchema: Type.Object({ subject: Type.String({ maxLength: 100 }) }),
  annotations: { readOnlyHint: false, untrustedContentHint: true },
  execute: ({ subject }) => createTicket(subject),
});
```

The wrapper targets the July 10, 2026 Community Group draft, including the
`Document.modelContext` location, promise-returning registration, abort-signal
unregistration, exact `exposedTo` origins, and the `readOnlyHint` and
`untrustedContentHint` annotations. WebMCP is a draft Community Group Report,
not yet a W3C Standard; keeping browser access behind `WebMcpModelContext`
isolates draft changes from application code.

Use `createWebMcpTestContext()` for deterministic unit and conformance tests in
Bun or Node. It deliberately adds `getTools()` and `executeTool()` only to the
test adapter; those methods are not presented as browser-standard APIs.

## Same-origin HTTP actions

`createWebMcpHttpProjectionDocument()` and
`bootstrapWebMcpHttpActions()` project an authenticated application's typed
HTTP actions without duplicating its domain implementation in the browser. The
bootstrap accepts only origin-relative endpoints on the current trustworthy
origin, sends credentials only with same-origin requests, refuses redirects,
bounds documents and responses before parsing, validates every tool, and rolls
back the complete registration if any tool fails. It never uses `exposedTo`, so
cross-origin frames receive no capability by default.

The HTTP server remains the authorization and audit boundary. The browser
registry validates structured input and metadata, but a successful tool call
still requires the server's current session, resource, and domain checks.

```ts
const mounted = await bootstrapWebMcpHttpActions({
  manifestPath: "/api/owner/webmcp",
  actionBasePath: "/api/owner/webmcp/actions/",
  formats: {
    uuid: (value) => /^[0-9a-f-]{36}$/iu.test(value),
  },
});

// Unregister every tool when the authenticated page unmounts or signs out.
mounted.dispose();
```

Specification: <https://webmachinelearning.github.io/webmcp/>

## License

MIT
