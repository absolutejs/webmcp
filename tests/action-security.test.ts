import { test, expect } from "bun:test";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import {
  createAgency,
  createMemoryAgencyStore,
  allowAllPolicy,
} from "@absolutejs/agency";
import {
  createInMemoryWebAuthnCredentialStore,
  createInMemoryWebAuthnChallengeStore,
} from "@absolutejs/auth";
import { createSimpleWebAuthnAdapter } from "@absolutejs/auth/webauthn";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { slidingWindow, memoryStore } from "@absolutejs/rate-limit/core";
import { Type } from "@sinclair/typebox";
import {
  createWebMcpHttpActionTools,
  createWebMcpEffectCatalog,
  createWebMcpRegistry,
  createWebMcpTestContext,
  createWebMcpHttpProjectionDocument,
} from "../src";
import { createWebMcpActionServer } from "../src/server";

const session = {
  sessionId: "s1",
  actor: { userId: "u1", agentId: "a1", scopes: ["send"] },
};
const read = {
  transportName: "preview",
  risk: "R0",
  authorization: { effects: ["read"] },
};
const send = {
  transportName: "send",
  risk: "R1",
  authorization: { effects: ["send"] },
};
const schema = Type.Object(
  { to: Type.String() },
  { additionalProperties: false },
);
test("a conflicting or unknown tool is rejected before projection and batch registration", async () => {
  const effectCatalog = createWebMcpEffectCatalog([read, send]);
  const modelContext = createWebMcpTestContext();
  const registry = createWebMcpRegistry({ effectCatalog, modelContext });
  let registrations = 0;
  modelContext.addEventListener("toolchange", () => registrations++);
  const descriptor = {
    name: "preview",
    annotations: { readOnlyHint: true },
    description: "Read a preview",
    inputSchema: schema,
    execute: () => true,
  };
  await expect(
    registry.registerAll([descriptor, { ...descriptor, name: "send" }]),
  ).rejects.toThrow("conflicts");
  expect(registrations).toBe(0);
  expect(() =>
    createWebMcpHttpProjectionDocument(
      [{ ...descriptor, name: "unknown" }],
      effectCatalog,
    ),
  ).toThrow("absent");
});

const fixture = async (cap = 10) => {
  const agencyStore = createMemoryAgencyStore(),
    credentials = createInMemoryWebAuthnCredentialStore();
  let now = Date.now(),
    allowed = true;
  const agency = createAgency({
    store: agencyStore,
    policy: allowAllPolicy(),
    now: () => now,
  });
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const coseKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  const credentialId = Buffer.from("test-passkey").toString("base64url");
  await credentials.saveCredential({
    credentialId,
    userId: "u1",
    counter: 0,
    publicKey: Buffer.from(coseKey).toString("base64url"),
    createdAt: now,
  });
  const run = async (input: object) => {
    calls.push(input);
    return input;
  };
  const calls: object[] = [];
  const server = createWebMcpActionServer({
    actions: [
      { ...read, inputSchema: schema, run },
      { ...send, inputSchema: schema, run },
    ],
    actionStore: agencyStore,
    agency,
    authorize: () => allowed,
    now: () => now,
    rateLimit: {
      algorithm: slidingWindow({ requestsPerPeriod: cap, periodMs: 60_000 }),
      store: memoryStore(),
    },
    passkeys: {
      adapter: await createSimpleWebAuthnAdapter(),
      origin: "https://example.org",
      rpId: "example.org",
      challenges: createInMemoryWebAuthnChallengeStore(),
      credentials: {
        ...credentials,
        recordCredentialUse: async (c, n) => {
          await credentials.saveCredential({ ...c, counter: n });
          return true;
        },
      },
    },
  });
  const start = async () => {
    const result = await server.invoke(session, "send", { to: "one" });
    if (result.kind !== "approval-required") throw Error();
    return result;
  };
  const assertion = (challenge: unknown, flags = 5) => {
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        origin: "https://example.org",
        challenge,
      }),
    );
    const authData = Buffer.alloc(37);
    createHash("sha256").update("example.org").digest().copy(authData);
    authData[32] = flags;
    authData.writeUInt32BE(1, 33);
    const signature = sign(
      "sha256",
      Buffer.concat([
        authData,
        createHash("sha256").update(clientData).digest(),
      ]),
      pair.privateKey,
    );
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
      },
    };
  };
  return {
    server,
    start,
    assertion,
    calls,
    agencyStore,
    revoke: () => {
      allowed = false;
    },
    expire: () => {
      now += 130_000;
    },
  };
};

test("verified passkey executes exactly once for the original session, action and input", async () => {
  const f = await fixture();
  const p = await f.start();
  expect(p.publicKey.userVerification).toBe("required");
  expect(f.calls).toEqual([]);
  const proof = f.assertion(p.publicKey.challenge);
  await expect(
    f.server.confirm({ ...session, sessionId: "another" }, p.actionId, proof),
  ).rejects.toThrow();
  const results = await Promise.allSettled([
    f.server.confirm(session, p.actionId, proof),
    f.server.confirm(session, p.actionId, proof),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.calls).toEqual([{ to: "one" }]);
  const leases = await f.agencyStore.listLeases();
  expect(leases).toHaveLength(1);
  expect(leases[0]?.consumedAt).toBeDefined();
});

test("approval fails closed for missing UV, changed inputs, expired actions and revoked access", async () => {
  for (const reason of [
    "verification",
    "binding",
    "expiry",
    "revoked",
    "wrong-challenge",
  ]) {
    const f = await fixture(),
      p = await f.start();
    if (reason === "expiry") f.expire();
    if (reason === "revoked") f.revoke();
    if (reason === "binding") {
      const action = await f.agencyStore.getAction(p.actionId);
      await f.agencyStore.replaceAction({ ...action!, input: { to: "two" } });
    }
    await expect(
      f.server.confirm(
        session,
        p.actionId,
        f.assertion(
          reason === "wrong-challenge" ? "other" : p.publicKey.challenge,
          reason === "verification" ? 1 : 5,
        ),
      ),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  }
});
test("actor-action quotas survive a change of session and keep tool budgets independent", async () => {
  const f = await fixture(1);
  expect((await f.server.invoke(session, "preview", { to: "one" })).kind).toBe(
    "executed",
  );
  await expect(
    f.server.invoke({ ...session, sessionId: "s2" }, "preview", { to: "two" }),
  ).rejects.toMatchObject({ status: 429 });
  expect((await f.start()).kind).toBe("approval-required");
});

test("the HTTP adapter completes a bound 428 through the configured confirmation route", async () => {
  const f = await fixture();
  const descriptor = {
    name: "send",
    description: "Send the request",
    inputSchema: schema,
  };
  const calls: string[] = [];
  const handles = createWebMcpHttpActionTools({
    origin: "https://example.org",
    actionBasePath: "/actions/",
    tools: [descriptor],
    approval: {
      confirmPath: "/confirm",
      requestAssertion: async (review) => {
        expect(review.input).toEqual({ to: "one" });
        return f.assertion(review.publicKey.challenge);
      },
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      const body = JSON.parse(String(init?.body));
      if (path === "/actions/send")
        return Response.json(await f.server.invoke(session, "send", body), {
          status: 428,
        });
      const decision = await f.server.confirm(
        session,
        body.actionId,
        body.assertion,
      );
      return Response.json(decision.result);
    },
  });
  expect(await handles[0]!.execute({ to: "one" })).toEqual({ to: "one" });
  expect(calls).toEqual(["/actions/send", "/confirm"]);
  let prompted = false;
  const decision = await f.start();
  const wrong = createWebMcpHttpActionTools({
    origin: "https://example.org",
    actionBasePath: "/actions/",
    tools: [descriptor],
    approval: {
      confirmPath: "/confirm",
      requestAssertion: async () => {
        prompted = true;
      },
    },
    fetch: async () => Response.json(decision, { status: 428 }),
  });
  await expect(wrong[0]!.execute({ to: "two" })).rejects.toThrow(
    "Invalid WebMCP approval",
  );
  expect(prompted).toBe(false);
});
