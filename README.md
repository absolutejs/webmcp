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

The registry applies its authorization policy to tools registered through it.
Other scripts can register tools independently through the browser API. For
HTTP-projected actions, the server authorizes the underlying request.

The `authorize` callback receives the validated input and its SHA-256
`inputHash`, which also appears on the audit receipt. An application approval
workflow can bind a decision to the user, tool name, and input hash. Returning
`approval-required` stops that invocation and exposes the application's
`actionId` on the error. On a subsequent call, the application must check the
approval again before returning `allow`.

For progressive enhancement in browsers where WebMCP may not be available,
use the non-throwing constructor:

```ts
import { tryCreateWebMcpRegistry } from "@absolutejs/webmcp";

const tools = tryCreateWebMcpRegistry({ authorize });
if (tools) await tools.register(tool);
```

`isWebMcpAvailable()` is also available for feature-gated UI. Keep using
`createWebMcpRegistry()` when unsupported WebMCP should be treated as a
configuration error.

The wrapper targets the July 10, 2026 Community Group draft, including the
`Document.modelContext` location, promise-returning registration, abort-signal
unregistration, exact `exposedTo` origins, and the `readOnlyHint` and
`untrustedContentHint` annotations. WebMCP is a draft Community Group Report,
not yet a W3C Standard; keeping browser access behind `WebMcpModelContext`
isolates draft changes from application code.

## Inspecting registration coverage

Call `await tools.inspectCoverage()` to compare the registry's active names
with the tools visible to this document. The HTTP bootstrap handle exposes
the same method. Call it again after registrations change to refresh the snapshot.

```ts
const report = await tools.inspectCoverage();
if (report.discovery === "available") {
  for (const tool of report.visible) {
    console.info(tool.name, tool.coverage);
  }
}
```

`registered` identifies this registry's active registration by descriptor
identity or by name and registering window. `outside-registry` identifies
other visible tools, including same-name tools from another identified window.
`unverified` means discovery lacks enough information to attribute the entry.
Entries are reported individually so duplicate names remain visible. The
report is diagnostic and must never authorize an invocation.

Discovery uses the host's optional `getTools()` with its default visibility
scope. Hosts without discovery return `discovery: "unavailable"` alongside
the registry's own active names. A failed host discovery call rejects.
Inspection reads metadata without invoking tools or modifying browser APIs.

Use `createWebMcpTestContext()` for deterministic tests in Bun or Node. Its
synchronous `getTools()` and name-based `executeTool()` are test conveniences.
The November 2026 draft specifies asynchronous discovery and execution by
discovered tool handle.

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

## Invocation and page lifecycle

An invocation supplies `{ signal }` to both the authorization policy and the
tool handler. Pass it to pending approvals and cancellable I/O. Unregistering
the tool also cancels active invocations. The audit outcome is `cancelled`.
The HTTP adapter forwards cancellation to its request. A server may already
have committed a side effect when cancellation arrives.

Declare an optional TypeBox `outputSchema` alongside `inputSchema` to type the
handler result at registration and validate it before delivery. HTTP projection
documents carry both schemas. An invalid result fails the invocation after the
handler has run.

Pass the page mount's `signal` to `bootstrapWebMcpHttpActions` to cancel setup
and remove its tools when the page unmounts. Bootstrap announces its readiness
promise to hosts supporting `waitForToolsUntil()`. If you lazy-load the package,
announce the outer import-and-mount promise when that import starts.

```ts
const stop = registry.watchCoverage((update) => {
  if (update.discovery === "error") reportError(update.error);
  else renderCoverage(update);
});
// When the view unmounts
stop();
```

Subscriptions refresh after local registrations and host `toolchange` events.
Disposing the registry also ends its subscriptions.

## Checking a trusted action catalog

Build the policy from the application's own action definitions. The transport
name is the name exposed to the agent. An R0 action with exactly one `read`
effect may claim `readOnlyHint: true`.

```ts
const effectCatalog = createWebMcpEffectCatalog(applicationActions);
const registry = createWebMcpRegistry({ authorize, effectCatalog });
const document = createWebMcpHttpProjectionDocument(descriptors, effectCatalog);
```

Supply the catalog to `bootstrapWebMcpHttpActions` to check fetched descriptors
in the browser as well. Unknown tools and incompatible hints fail before
registration. These checks cover the registrations made through this registry.

## Executing server actions with passkey approval

The `@absolutejs/webmcp/server` entry point composes the host application's
Agency, Auth WebAuthn adapter, and rate-limit store. Each action supplies its
trusted catalog fields, TypeBox input schema, and domain handler. The server
validates the input and applies the application's authorization policy. It
requires a fresh passkey assertion for a write, any risk above R0, or an action
whose catalog or Agency policy calls for approval.

```ts
import { createWebMcpActionServer } from "@absolutejs/webmcp/server";
import { createSimpleWebAuthnAdapter } from "@absolutejs/auth/webauthn";
import { slidingWindow } from "@absolutejs/rate-limit/core";

const actions = createWebMcpActionServer({
  actions: applicationActions,
  authorize: canActOnResource,
  agency,
  actionStore, // same store used by agency
  rateLimit: {
    algorithm: slidingWindow({ requestsPerPeriod: 30, periodMs: 60_000 }),
    store: sharedRateLimitStore,
  },
  passkeys: {
    origin: "https://app.example.com",
    rpId: "app.example.com",
    adapter: await createSimpleWebAuthnAdapter(),
    challenges: challengeStore,
    credentials: credentialStore,
  },
});
```

Use Agency and challenge stores shared across server replicas. The credential
store's `recordCredentialUse` operation checks ownership, public key, and prior
counter atomically. The stores shipped with Auth 0.103.4 lack this method.
Use a store implementing the operation or an Auth release that includes it.
The server checks for the operation at startup. The rate-limit store charges the authenticated user and action
across sessions, with separate buckets for invocation and confirmation.

Mount two same-origin POST routes under the application's existing session,
origin, and body-size checks. Derive `{ sessionId, actor }` on the server for
each request. The invocation route calls `actions.invoke(session, toolName,
input)`. Return an executed action's `result` as JSON. For `approval-required`,
return the entire decision as JSON with HTTP 428 and `Cache-Control: no-store`.
The confirmation route calls `actions.confirm(session, actionId, assertion)` and
returns its `result` as JSON. Map `WebMcpActionError.status` to the HTTP status
and include its `retryAfterSec` as `Retry-After` on a 429.

On the browser side, configure `approval` on the HTTP bootstrap handle's
options. The app owns the human review interaction.

```ts
approval: {
  confirmPath: "/api/owner/webmcp/confirm",
  requestAssertion: async ({ name, input, publicKey, signal }) => {
    await reviewActionWithUser(name, input, signal); // reject on dismissal
    return authenticateWithPasskey(publicKey, signal); // JSON assertion
  },
}
```

The browser matches the action and exact input hash before asking for a
passkey. The server consumes the challenge once, verifies the assertion for
the configured origin and RP with user verification required, rechecks access,
and executes the saved input through one Agency lease. The action expires
after two minutes. A new invocation is a new operation; applications that
support business-level retries should retain their existing idempotency keys.
