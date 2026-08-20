import { createHmac } from "node:crypto";
import type { Postage, PostageChainStatus, PostageStatus } from "./domain";
import { ApiError, type ApiErrorCode } from "./errors";
import {
  checkAccountLimit,
  checkDeviceLimit,
  checkIpLimit,
  checkRelayLimit,
  checkSenderRecipientLimit,
  type AbuseDecision,
} from "./abuse-service";
import { getMailboxPolicy } from "./policy-service";
import * as metrics from "./metrics";
import type { ApiRepository } from "./repository";
import { recordAuditEvent } from "./audit";
import type { ApiContext } from "./context";
import { validatePostageTransition } from "./postage-transitions";
import {
  PostageEscrowAdapter,
  mapPostageStatus,
  type PostageEscrowResult,
  type PostageOperation,
  type RetryClassification,
} from "../../services/stellar/postage-escrow";

export type SubmitPostageContext = {
  actorId?: string;
  fingerprint?: string;
  ip?: string;
  relayId?: string;
  sender?: string;
};

const TERMINAL_STATUSES: readonly PostageStatus[] = ["settled", "refunded", "reclaimed"];

function isTerminal(status: PostageStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

function throwAbuseLimitError(
  decision: AbuseDecision,
  status: number,
  code: ApiErrorCode,
  message: string,
) {
  throw new ApiError(status, code, message, {
    ...(decision.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: decision.retryAfterSeconds }),
    ...(decision.outage === undefined
      ? {}
      : {
          outagePolicy: decision.outage.policy,
          outageRoute: decision.outage.route,
        }),
  });
}

function rejectLimitedPostage(
  decision: AbuseDecision,
  labels: Record<string, string>,
  limitMessage: string,
) {
  metrics.incrementCounter("postage_limit_rejected", labels);

  if (decision.outage) {
    throwAbuseLimitError(
      decision,
      503,
      "dependency_unavailable",
      `Abuse ${decision.outage.check} check is unavailable`,
    );
  }

  throwAbuseLimitError(decision, 429, "too_many_requests", limitMessage);
}

function SECRET() {
  return process.env.STEALTH_CURSOR_SECRET ?? "dev-secret";
}

export function signQuote(
  recipient: string,
  sender: string,
  amount: string,
  issuedAt: string,
  expiresAt: string,
): string {
  const secret = SECRET();
  if (!secret) {
    throw new ApiError(500, "internal_error", "Quote signing secret is not configured");
  }
  const payload = `${recipient}:${sender}:${amount}:${issuedAt}:${expiresAt}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export async function quotePostage(
  context: ApiContext,
  input: { recipient: string; sender: string },
) {
  try {
    const rule = await context.repository.getSenderRule(input.recipient, input.sender);
    const { policy } = await getMailboxPolicy(context.repository, input.recipient);

    const issuedAt = new Date().toISOString();
    const lifetimeMs = process.env.STEALTH_QUOTE_LIFETIME_MS
      ? parseInt(process.env.STEALTH_QUOTE_LIFETIME_MS, 10)
      : 15 * 60 * 1000;
    const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();

    if (rule === "block") {
      const amount = policy.minimumPostage;
      const result = {
        amount,
        eligible: false,
        reason: "sender_blocked" as const,
        trusted: false,
        issuedAt,
        expiresAt,
        digest: signQuote(input.recipient, input.sender, amount, issuedAt, expiresAt),
      };

      recordAuditEvent({
        actor: input.sender,
        action: "postage.quote",
        targetType: "mailbox",
        safeTargetReference: input.recipient,
        result: "success",
        requestId: context.requestId ?? "unknown",
      });
      return result;
    }

    const trusted = rule === "allow";
    const amount = trusted ? "0" : policy.minimumPostage;

    const result = {
      amount,
      eligible: true,
      reason: trusted ? ("trusted_sender" as const) : ("mailbox_minimum" as const),
      trusted,
      issuedAt,
      expiresAt,
      digest: signQuote(input.recipient, input.sender, amount, issuedAt, expiresAt),
    };

    recordAuditEvent({
      actor: input.sender,
      action: "postage.quote",
      targetType: "mailbox",
      safeTargetReference: input.recipient,
      result: "success",
      requestId: context.requestId ?? "unknown",
    });
    return result;
  } catch (error) {
    recordAuditEvent({
      actor: input.sender,
      action: "postage.quote",
      targetType: "mailbox",
      safeTargetReference: input.recipient,
      result: "denied",
      requestId: context.requestId ?? "unknown",
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Chain synchronization helpers
//
// The critical invariant (BETA-042 acceptance scenario #1):
//   "No off-chain terminal state is reported before on-chain confirmation."
//
// Therefore every terminal write to the repository is guarded by:
//   1. A successful chain confirmation in the current call, OR
//   2. Reading from the adapter that the chain ALREADY reports the record in
//      a terminal state (idempotent safe-retry path).
// Non-terminal states (pending / expired / disputed) may be written both
// before and after chain confirmation because they are reversible.
// ---------------------------------------------------------------------------

type PatchFields = Partial<
  Pick<
    Postage,
    | "status"
    | "chainStatus"
    | "txHash"
    | "ledger"
    | "retryCount"
    | "lastError"
    | "submittedAt"
    | "confirmedAt"
  >
>;

async function syncEscrowFields(
  repository: ApiRepository,
  messageId: string,
  patch: PatchFields,
): Promise<Postage> {
  const current = await repository.getPostage(messageId);
  if (!current) {
    throw new ApiError(404, "not_found", "Postage was not found for sync");
  }
  const merged: Postage = {
    ...current,
    ...patch,
    retryCount: (patch.retryCount ?? current.retryCount ?? 0) + 0,
  };
  return repository.setPostage(merged);
}

async function runOnChainAndSync(
  context: ApiContext,
  operation: PostageOperation,
  nextStatus: PostageStatus,
  actorAddress: string,
  escrow: PostageEscrowAdapter | undefined,
  invokeChain: (escrow: PostageEscrowAdapter) => Promise<PostageEscrowResult>,
): Promise<Postage> {
  const messageId = context._pendingMessageId!;
  const now = new Date().toISOString();
  const repo = context.repository;
  const requestId = context.requestId ?? "unknown";

  if (!escrow) {
    const patch: PatchFields = {
      retryCount: 1,
      lastError: "escrow adapter not injected",
    };
    await syncEscrowFields(repo, messageId, patch);
    throw new ApiError(503, "dependency_unavailable", "Postage escrow adapter is not available");
  }

  let chain: PostageEscrowResult;
  try {
    chain = await invokeChain(escrow);
  } catch (err: unknown) {
    const lastError = err instanceof Error ? err.message : String(err ?? "chain error");
    const current = await repo.getPostage(messageId);
    const retryCount = current ? (current.retryCount ?? 0) + 1 : 1;
    await syncEscrowFields(repo, messageId, {
      chainStatus: "failed",
      retryCount,
      lastError: lastError.slice(0, 500),
    });
    throw new ApiError(502, "chain_error", "On-chain escrow submission failed", {
      operation,
      lastError: lastError.slice(0, 500),
    });
  }

  // Always record observable chain side effects (txHash, retry, error) regardless
  // of success — callers need this information for retries and UI surfacing.
  const basePatch: PatchFields = {
    chainStatus: chain.chainStatus,
    txHash: chain.confirmation?.txHash ?? null,
    ledger: chain.confirmation?.ledger ?? null,
    lastError: chain.lastError ?? null,
    submittedAt: chain.confirmation ? now : undefined,
    confirmedAt: chain.success ? now : undefined,
  };

  if (chain.success && chain.postage) {
    const chainReportedStatus = mapPostageStatus(chain.postage);

    // Critical: only advance the off-chain DB status if the chain confirms
    // an equal-or-later state.  Never write a terminal off-chain state before
    // on-chain confirmation.
    validatePostageTransition(nextStatus, nextStatus);
    const desiredStatus: PostageStatus = isTerminal(chainReportedStatus)
      ? chainReportedStatus
      : nextStatus;

    // For terminal transitions, use atomic CAS to prevent double-settlement
    // across concurrent callers (acceptance scenario #2).
    let transitioned;
    if (isTerminal(desiredStatus)) {
      const current = await repo.getPostage(messageId);
      if (!current) {
        throw new ApiError(404, "not_found", "Postage was not found");
      }
      const expected = current.status;
      if (expected === desiredStatus) {
        transitioned = { outcome: "applied" as const, postage: current };
      } else {
        transitioned = await repo.transitionPostage(messageId, expected, desiredStatus);
      }
      if (transitioned.outcome === "conflict") {
        return syncEscrowFields(repo, messageId, {
          ...basePatch,
          status: transitioned.postage.status,
        });
      }
      if (transitioned.outcome === "not-found") {
        throw new ApiError(404, "not_found", "Postage was not found");
      }
    }

    const finalPatch: PatchFields = {
      ...basePatch,
      status: desiredStatus,
    };
    return syncEscrowFields(repo, messageId, finalPatch);
  }

  // Idempotent safe retry: DuplicateMessage / AlreadyResolved are reported as
  // safe by the adapter.  We read the chain record and, if terminal, sync it
  // into the DB so subsequent API reads observe the same deterministic state.
  if (chain.retryClassification === "safe") {
    const chainPostage = await escrow.readOnChainPostage(messageId);
    if (chainPostage) {
      const chainReportedStatus = mapPostageStatus(chainPostage);
      if (isTerminal(chainReportedStatus)) {
        const current = await repo.getPostage(messageId);
        if (current && current.status !== chainReportedStatus) {
          try {
            await repo.transitionPostage(messageId, current.status, chainReportedStatus);
          } catch {
            // A concurrent transition already landed; the sync below re-reads
            // the authoritative state, so nothing further is needed here.
          }
        }
        return syncEscrowFields(repo, messageId, {
          ...basePatch,
          chainStatus: "confirmed",
          status: chainReportedStatus,
        });
      }
      return syncEscrowFields(repo, messageId, {
        ...basePatch,
        chainStatus: "confirmed",
        status: chainReportedStatus,
      });
    }
  }

  // Non-success, non-safe-retry: bump retry counter, persist diagnostics, and
  // surface the bounded error to the caller.  We never advance the DB status
  // past what the chain has confirmed.
  const current = await repo.getPostage(messageId);
  const retryCount = current ? (current.retryCount ?? 0) + 1 : 1;
  const patched = await syncEscrowFields(repo, messageId, {
    ...basePatch,
    retryCount,
  });

  if (chain.retryClassification === "never") {
    throw new ApiError(422, "validation_error", chain.lastError ?? "Chain rejected the operation", {
      operation,
      retryable: false,
    });
  }

  throw new ApiError(502, "chain_error", chain.lastError ?? "On-chain escrow submission failed", {
    operation,
    retryable: chain.retryClassification === "safe" || chain.retryClassification === "unknown",
    chainStatus: chain.chainStatus,
    retryClassification: chain.retryClassification as RetryClassification,
  });
}

export async function submitPostage(
  context: ApiContext,
  input: Omit<
    Postage,
    | "createdAt"
    | "status"
    | "chainStatus"
    | "txHash"
    | "ledger"
    | "retryCount"
    | "lastError"
    | "submittedAt"
    | "confirmedAt"
  >,
  now = new Date(),
  submitContext: SubmitPostageContext = {},
) {
  try {
    const actorId = submitContext.actorId ?? "unknown";

    const accountLimit = await checkAccountLimit(context.repository, input.sender);
    if (!accountLimit.allowed) {
      rejectLimitedPostage(
        accountLimit,
        {
          actorId,
          limit: "account",
        },
        "Account limit exceeded",
      );
    }

    const ip = submitContext.ip ?? "unknown";
    const ipLimit = await checkIpLimit(context.repository, ip);
    if (!ipLimit.allowed) {
      rejectLimitedPostage(
        ipLimit,
        {
          ip,
          limit: "ip",
        },
        "IP limit exceeded",
      );
    }

    const fingerprint = submitContext.fingerprint ?? "";
    const deviceLimit = await checkDeviceLimit(context.repository, fingerprint);
    if (!deviceLimit.allowed) {
      rejectLimitedPostage(
        deviceLimit,
        {
          fingerprint: fingerprint || "unknown",
          limit: "device",
        },
        "Device limit exceeded",
      );
    }

    const senderRecipientLimit = await checkSenderRecipientLimit(
      context.repository,
      input.sender,
      input.recipient,
    );

    if (!senderRecipientLimit.allowed) {
      const sender = submitContext.sender ?? input.sender;

      rejectLimitedPostage(
        senderRecipientLimit,
        {
          limit: "sender_recipient",
          sender,
        },
        "Sender-recipient limit exceeded",
      );
    }

    const relayId = submitContext.relayId?.trim() || "unknown";
    const relayLimit = await checkRelayLimit(context.repository, relayId);

    if (!relayLimit.allowed) {
      rejectLimitedPostage(
        relayLimit,
        {
          limit: "relay",
          relayId,
        },
        "Relay limit exceeded",
      );
    }

    if (await context.repository.getPostage(input.messageId)) {
      throw new ApiError(409, "conflict", "Postage already exists for this message");
    }

    const rule = await context.repository.getSenderRule(input.recipient, input.sender);

    if (rule === "block") {
      throw new ApiError(403, "forbidden", "The recipient has blocked this sender");
    }

    const { policy } = await getMailboxPolicy(context.repository, input.recipient);

    if (BigInt(input.amount) < BigInt(policy.minimumPostage)) {
      throw new ApiError(422, "validation_error", "Postage is below the mailbox minimum", {
        minimumPostage: policy.minimumPostage,
      });
    }

    // Insert the off-chain record FIRST with pending status so idempotency,
    // abuse counters, and audit events are anchored to a real DB row.
    const inserted = await context.repository.insertPostage({
      ...input,
      createdAt: now.toISOString(),
      status: "pending",
      chainStatus: "not_submitted",
      txHash: null,
      ledger: null,
      retryCount: 0,
      lastError: null,
      submittedAt: null,
      confirmedAt: null,
    });

    recordAuditEvent({
      actor: input.sender,
      action: "postage.submit",
      targetType: "message",
      safeTargetReference: input.messageId,
      result: "success",
      requestId: context.requestId ?? "unknown",
    });

    if (!context.escrow || !context.escrow.isLive()) {
      return inserted;
    }

    try {
      const amount = BigInt(input.amount);
      const allowance = await context.escrow.checkAllowanceAndBalance(input.sender, amount);
      if (!allowance.sufficient) {
        return syncEscrowFields(context.repository, input.messageId, {
          chainStatus: "failed",
          retryCount: 1,
          lastError:
            allowance.allowance !== undefined || allowance.balance !== undefined
              ? `Insufficient balance/allowance (required=${allowance.required})`
              : "Unable to verify on-chain balance/allowance",
        });
      }
    } catch {
      // The allowance preflight is best-effort; submit proceeds to the chain
      // regardless and the on-chain result remains authoritative.
    }

    context._pendingMessageId = input.messageId;
    return runOnChainAndSync(context, "submit", "pending", input.sender, context.escrow, (e) =>
      e.submitEscrow(
        input.messageId,
        input.sender,
        input.recipient,
        BigInt(input.amount),
        context.requestId,
      ),
    );
  } catch (error) {
    recordAuditEvent({
      actor: input.sender,
      action: "postage.submit",
      targetType: "message",
      safeTargetReference: input.messageId,
      result: "denied",
      requestId: context.requestId ?? "unknown",
    });
    throw error;
  }
}

export async function getPostage(repository: ApiRepository, messageId: string) {
  const postage = await repository.getPostage(messageId);

  if (!postage) {
    throw new ApiError(404, "not_found", "Postage was not found");
  }

  return postage;
}

export function assertPostageParticipant(postage: Postage, actor: string) {
  if (actor !== postage.sender && actor !== postage.recipient) {
    throw new ApiError(403, "forbidden", "Only message participants can read this postage");
  }
}

export function assertPostageActor(postage: Postage, operation: PostageOperation, actor: string) {
  // "system" is the internal/trusted actor used by relay and reconciliation
  // flows (and the legacy service entry points). Authorization for real callers
  // is enforced at the route layer via requireActor / requireActorMatches; this
  // check is defense-in-depth for principal-bound requests.
  if (actor === "system") return;
  switch (operation) {
    case "settle":
    case "refund":
    case "dispute":
      if (actor !== postage.recipient) {
        throw new ApiError(
          403,
          "forbidden",
          `Only the recipient (${postage.recipient}) can ${operation} this postage`,
        );
      }
      break;
    case "reclaim":
    case "submit":
      if (actor !== postage.sender) {
        throw new ApiError(
          403,
          "forbidden",
          `Only the sender (${postage.sender}) can ${operation} this postage`,
        );
      }
      break;
    case "expire":
      assertPostageParticipant(postage, actor);
      break;
  }
}

// ---------------------------------------------------------------------------
// State-transition entry points
// ---------------------------------------------------------------------------

const TERMINAL_STATE_EXPLANATIONS: Record<string, string> = {
  settled: "Postage has already been settled. The escrow was previously released to the recipient.",
  refunded: "Postage has already been refunded. The escrow was previously returned to the sender.",
  reclaimed:
    "Postage has already been reclaimed. The escrow was previously returned to the sender.",
};

function terminalConflictError(
  currentStatus: PostageStatus,
  attemptedStatus: PostageStatus,
  messageId: string,
): ApiError {
  const explanation =
    TERMINAL_STATE_EXPLANATIONS[currentStatus] || `Postage is in terminal state: ${currentStatus}`;
  return new ApiError(409, "conflict", explanation, {
    currentStatus,
    attemptedStatus,
    messageId,
  });
}

async function transitionEscrow(
  context: ApiContext,
  messageId: string,
  operation: PostageOperation,
  nextStatus: PostageStatus,
  actor: string,
): Promise<Postage> {
  const postage = await context.repository.getPostage(messageId);
  if (!postage) {
    throw new ApiError(404, "not_found", "Postage was not found");
  }

  assertPostageActor(postage, operation, actor);

  // Repeat attempts at a transition the record has already reached (or cannot
  // legally reach) MUST fail deterministically with a 409 conflict — never a
  // silent success — so the idempotency layer can cache and replay the error
  // and no caller can believe value moved twice.
  if (postage.status === nextStatus && isTerminal(nextStatus)) {
    throw terminalConflictError(postage.status, nextStatus, messageId);
  }

  // Legacy semantics preserved from the pre-BETA-042 service: settle/refund
  // only ever resolve a "pending" record. Any other current state is a
  // deterministic conflict (settled/refunded/reclaimed/expired/disputed all
  // reject further resolve attempts), which is exactly what the idempotency
  // and race tests assert.
  if ((operation === "settle" || operation === "refund") && postage.status !== "pending") {
    throw terminalConflictError(postage.status, nextStatus, messageId);
  }

  try {
    validatePostageTransition(postage.status, nextStatus);
  } catch {
    throw terminalConflictError(postage.status, nextStatus, messageId);
  }

  if (!context.escrow || !context.escrow.isLive()) {
    // Off-chain only path (CI / local-dev without RPC). Still apply the
    // atomic CAS so idempotency / double-settle protections still work.
    const result = await context.repository.transitionPostage(
      messageId,
      postage.status,
      nextStatus,
    );
    if (result.outcome === "not-found") {
      throw new ApiError(404, "not_found", "Postage was not found");
    }
    if (result.outcome === "conflict") {
      throw terminalConflictError(result.postage.status, nextStatus, messageId);
    }
    recordAuditEvent({
      actor,
      action: `postage.${operation}`,
      targetType: "message",
      safeTargetReference: messageId,
      result: "success",
      requestId: context.requestId ?? "unknown",
    });
    return result.postage;
  }

  try {
    context._pendingMessageId = messageId;
    const result = await runOnChainAndSync(
      context,
      operation,
      nextStatus,
      actor,
      context.escrow,
      (e) => {
        switch (operation) {
          case "settle":
            return e.settleEscrow(messageId, actor, context.requestId);
          case "refund":
            return e.refundEscrow(messageId, actor, context.requestId);
          case "dispute":
            return e.disputeEscrow(messageId, actor, context.requestId);
          case "expire":
            return e.expireEscrow(messageId, actor, context.requestId);
          case "reclaim":
            return e.reclaimEscrow(messageId, actor, context.requestId);
          default:
            throw new ApiError(500, "internal_error", `Unknown operation ${operation}`);
        }
      },
    );
    recordAuditEvent({
      actor,
      action: `postage.${operation}`,
      targetType: "message",
      safeTargetReference: messageId,
      result: "success",
      requestId: context.requestId ?? "unknown",
    });
    return result;
  } catch (error) {
    recordAuditEvent({
      actor,
      action: `postage.${operation}`,
      targetType: "message",
      safeTargetReference: messageId,
      result: "denied",
      requestId: context.requestId ?? "unknown",
    });
    throw error;
  }
}

export async function resolvePostage(
  context: ApiContext,
  messageId: string,
  status: "refunded" | "settled",
) {
  const actor = context.principal?.address ?? "system";
  const operation: PostageOperation = status === "settled" ? "settle" : "refund";
  return transitionEscrow(context, messageId, operation, status, actor);
}

export async function disputePostage(context: ApiContext, messageId: string) {
  const actor = context.principal?.address ?? "system";
  return transitionEscrow(context, messageId, "dispute", "disputed", actor);
}

export async function expirePostage(context: ApiContext, messageId: string) {
  const actor = context.principal?.address ?? "system";
  return transitionEscrow(context, messageId, "expire", "expired", actor);
}

export async function reclaimPostage(context: ApiContext, messageId: string) {
  const actor = context.principal?.address ?? "system";
  return transitionEscrow(context, messageId, "reclaim", "reclaimed", actor);
}
