import type {
  Agency,
  AgencyStore,
  AgentActor,
  ActionRequest,
} from "@absolutejs/agency";
import type {
  WebAuthnAdapter,
  WebAuthnChallengeStore,
  WebAuthnCredential,
  WebAuthnCredentialStore,
} from "@absolutejs/auth";
import type { Algorithm, Store } from "@absolutejs/rate-limit/core";
import { createWebMcpEffectCatalog, type WebMcpCatalogAction } from "./effects";
import type { WebMcpAnnotations } from "./types";
import { assertWebMcpInput } from "./validate";
import type { TSchema } from "@sinclair/typebox";
import { createHash } from "./stable";

export type WebMcpServerSession = { sessionId: string; actor: AgentActor };
type ServerAction = WebMcpCatalogAction & {
  annotations?: WebMcpAnnotations;
  inputSchema: TSchema;
  run: (input: object, session: WebMcpServerSession) => Promise<unknown>;
};

export class WebMcpActionError extends Error {
  constructor(
    readonly status: 403 | 429,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}
const denied = () => new WebMcpActionError(403, "WebMCP action denied");

export const createWebMcpActionServer = (options: {
  actions: readonly ServerAction[];
  authorize: (
    session: WebMcpServerSession,
    name: string,
    input: object,
  ) => Promise<boolean> | boolean;
  agency: Agency;
  actionStore: Pick<AgencyStore, "getAction">;
  rateLimit: { algorithm: Algorithm; store: Store };
  passkeys: {
    origin: string;
    rpId: string;
    adapter: Pick<
      WebAuthnAdapter,
      "createAuthenticationOptions" | "verifyAuthentication"
    >;
    challenges: WebAuthnChallengeStore;
    credentials: Pick<
      WebAuthnCredentialStore,
      "getCredential" | "listCredentialsByUser"
    > & {
      recordCredentialUse: (
        expected: WebAuthnCredential,
        newCounter: number,
        usedAt: number,
      ) => Promise<boolean>;
    };
  };
  now?: () => number;
}) => {
  const now = options.now ?? Date.now;
  const { agency, passkeys, rateLimit } = options;
  if (typeof passkeys.credentials.recordCredentialUse !== "function")
    throw new TypeError(
      "WebMCP passkey approvals require a credential store with atomic recordCredentialUse support",
    );
  const catalog = createWebMcpEffectCatalog(options.actions);
  const tools = new Map(
    options.actions.map((tool) => [
      tool.transportName,
      {
        ...tool,
        policy: catalog.check({
          name: tool.transportName,
          annotations: tool.annotations,
        }),
      },
    ]),
  );
  const origin = new URL(passkeys.origin);
  if (
    origin.origin !== passkeys.origin ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "localhost")) ||
    !passkeys.rpId ||
    !(
      origin.hostname === passkeys.rpId ||
      origin.hostname.endsWith("." + passkeys.rpId)
    )
  )
    throw new Error("Invalid WebMCP passkey relying party");
  const authenticate = (session: WebMcpServerSession) => {
    if (!session?.actor?.userId || !session.actor.agentId || !session.sessionId)
      throw denied();
  };
  const limit = async (
    session: WebMcpServerSession,
    name: string,
    phase: "invoke" | "confirm",
  ) => {
    const key = JSON.stringify([
      "webmcp",
      phase,
      session.actor.organizationId ?? null,
      session.actor.userId,
      name,
    ]);
    const decision = await rateLimit.algorithm.check(
      rateLimit.store,
      key,
      now(),
    );
    if (decision.allowed !== true)
      throw new WebMcpActionError(
        429,
        "WebMCP action rate limit exceeded",
        decision.retryAfterSec,
      );
  };
  // A challenge belongs to one saved action and one exact set of arguments.
  const challengeId = async (action: ActionRequest) =>
    "webmcp:" + (await createHash(action));
  const execute = async (
    actionId: string,
    name: string,
    input: object,
    session: WebMcpServerSession,
  ) => {
    const tool = tools.get(name);
    if (
      !tool ||
      (await options.authorize(session, name, structuredClone(input))) !== true
    )
      throw denied();
    const lease = await agency.issueLease(actionId);
    const { result } = await agency.execute({
      executor: session.actor.agentId,
      leaseId: lease.leaseId,
      run: () => tool.run(input, session),
    });
    return { kind: "executed" as const, result };
  };
  const invoke = async (
    session: WebMcpServerSession,
    name: string,
    candidate: unknown,
  ) => {
    session = structuredClone(session);
    authenticate(session);
    const tool = tools.get(name);
    if (!tool) throw denied();
    await limit(session, name, "invoke");
    const input = assertWebMcpInput(
      tool.inputSchema,
      structuredClone(candidate),
    );
    if (
      (await options.authorize(session, name, structuredClone(input))) !== true
    )
      throw denied();
    const expiresAt = now() + 120_000;
    const { action, decision } = await agency.request({
      actor: session.actor,
      action: name,
      input,
      effects: tool.policy.effects,
      resource: { type: "webmcp-tool", id: name },
      expiresAt,
    });
    if (decision.kind === "deny" && !decision.requestable) throw denied();
    if (!tool.policy.requiresApproval && decision.kind === "allow")
      return execute(action.actionId, name, input, session);
    const credentials = await passkeys.credentials.listCredentialsByUser(
      session.actor.userId,
    );
    if (!credentials.length) throw denied();
    const auth = await passkeys.adapter.createAuthenticationOptions({
      allowCredentials: credentials.map((c) => ({ id: c.credentialId })),
      rpId: passkeys.rpId,
      userVerification: "required",
    });
    await passkeys.challenges.save({
      id: await challengeId(action),
      purpose: "approval",
      challenge: auth.challenge,
      userId: session.actor.userId,
      sessionId: session.sessionId,
      expiresAt,
    });
    return {
      kind: "approval-required" as const,
      actionId: action.actionId,
      toolName: name,
      inputHash: action.inputDigest,
      publicKey: auth.options,
      expiresAt,
    };
  };
  const confirm = async (
    session: WebMcpServerSession,
    actionId: string,
    response: unknown,
  ) => {
    session = structuredClone(session);
    authenticate(session);
    const action = await options.actionStore.getAction(actionId);
    if (
      !action ||
      action.resource.type !== "webmcp-tool" ||
      action.resource.id !== action.action ||
      !action.expiresAt ||
      action.expiresAt <= now() ||
      (await createHash(session.actor)) !== (await createHash(action.actor))
    )
      throw denied();
    const tool = tools.get(action.action);
    if (
      !tool ||
      (await createHash(tool.policy.effects)) !==
        (await createHash(action.effects))
    )
      throw denied();
    await limit(session, action.action, "confirm");
    const input = assertWebMcpInput(
      tool.inputSchema,
      structuredClone(action.input),
    );
    if ((await createHash(input)) !== action.inputDigest) throw denied();
    const challenge = await passkeys.challenges.consume({
      id: await challengeId(action),
      purpose: "approval",
      userId: session.actor.userId,
      sessionId: session.sessionId,
      now: now(),
    });
    if (!challenge || challenge.expiresAt <= now()) throw denied();
    const id =
      response && typeof response === "object"
        ? Reflect.get(response, "id")
        : undefined;
    if (typeof id !== "string") throw denied();
    const credential = await passkeys.credentials.getCredential(id);
    if (!credential || credential.userId !== session.actor.userId)
      throw denied();
    const proof = await passkeys.adapter
      .verifyAuthentication({
        credential,
        expectedChallenge: challenge.challenge,
        expectedOrigin: passkeys.origin,
        expectedRPID: passkeys.rpId,
        requireUserVerification: true,
        response,
      })
      .catch(() => {
        throw denied();
      });
    if (
      !proof.verified ||
      proof.newCounter === undefined ||
      !(await passkeys.credentials.recordCredentialUse(
        credential,
        proof.newCounter,
        now(),
      ))
    )
      throw denied();
    if (
      action.expiresAt <= now() ||
      (await options.authorize(
        session,
        action.action,
        structuredClone(input),
      )) !== true
    )
      throw denied();
    await agency.approve({
      actionId,
      approvedBy: session.actor.userId,
      approvedUntil: action.expiresAt,
    });
    return execute(actionId, action.action, input, session);
  };
  return { invoke, confirm };
};
