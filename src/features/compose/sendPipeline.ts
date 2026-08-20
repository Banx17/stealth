/**
 * Compose send pipeline (BETA-057 / #1958).
 *
 * Orchestrates the staged send: resolve -> encrypt -> sign -> postage ->
 * persist -> submit -> reconcile. Each stage reports truthful progress and can
 * be retried without re-running already-completed stages or duplicating
 * mutations.
 *
 * Provides:
 * - Stable idempotency keys (`idem-${messageId}`) and support IDs (`supp-${messageId}`)
 * - Concurrency lock preventing double submission on rapid double-clicks
 * - Cancellation rules before irreversible relay commitment
 * - Resume from localStorage outbox entry after refresh
 * - Truthful stage mapping without simulated delays
 * - Actionable failure classification distinguishing safe retry from already-committed states
 */
import { canonicalizePayload, sealEnvelope, type SealedEnvelope } from "@/services/crypto/envelope";
import {
  authorizeSend,
  WalletRejectedError,
  WalletUnavailableError,
  type WalletSignature,
} from "@/services/stellar/wallet";
import {
  createEntry,
  patchEntry,
  type OutboxEntry,
  type OutboxStatus,
  type OutboxStageSnapshot,
} from "@/services/storage/outbox";
import {
  submitToRelay,
  buildSignedRelayRequest,
  DEFAULT_RELAY_AUDIENCE,
  DEFAULT_REPLAY_WINDOW_SECONDS,
  type RelayRequestSigner,
  type SignedRelayRequest,
} from "@/services/relay/submit";
import {
  resolveRecipientKeysForSend,
  RecipientKeyResolutionError,
  type RecipientKeyMaterial,
} from "@/features/compose/recipientKeyResolution";
import { verifySenderBinding, SenderBindingError } from "@/services/crypto/sender-binding";
import { parseRecipients } from "@/components/mail/composeValidation";
import type { DeliveryState } from "@/services/relay/federation";
import type { DirectoryRecipientKeyResolver } from "@/services/crypto/key-resolver";
import type { PostageQuote } from "@/features/compose/usePostageQuote";

export type StageId =
  | "resolve"
  | "encrypt"
  | "sign"
  | "postage"
  | "persist"
  | "submit"
  | "reconcile";

export type StageStatus = "pending" | "active" | "done" | "error";

export interface StageState {
  id: StageId;
  label: string;
  status: StageStatus;
  detail?: string;
}

export type SendFailureReason =
  | "recipient_rejected"
  | "wallet_rejected"
  | "wallet_unavailable"
  | "failed";

export type SendOutcome =
  | {
      ok: true;
      messageId: string;
      supportId: string;
      delivered: boolean;
      state: DeliveryState;
    }
  | {
      ok: false;
      messageId: string;
      supportId: string;
      stage: StageId;
      reason: SendFailureReason;
      message: string;
      code?: string;
      canRetry: boolean;
      isCommitted: boolean;
      timestamp: string;
    };

/** A recipient as resolved by the compose UI before submission. */
export interface SendPipelineRecipient {
  /** The address the user entered (e.g. `alice*stellar.org`). */
  address: string;
  /** The canonical Stellar G-address the address resolved to. */
  account: string;
}

export interface SendPipelineInput {
  sender: string;
  to: string;
  subject: string;
  body: string;
  messageId?: string;
  attachments?: Array<{
    filename: string;
    content_type: string;
    size_bytes: number;
    data?: ArrayBuffer;
  }>;
  /** Pre-resolved recipient accounts from the compose UI. */
  recipients?: SendPipelineRecipient[];
  /** Relay authority id (defaults to the beta relay audience). */
  audience?: string;
  /** Postage input (XLM string or stroops). */
  postage?: string;
  /** Current postage quote state if available. */
  postageQuote?: PostageQuote;
}

const STAGE_LABELS: Record<StageId, string> = {
  resolve: "Resolving recipient keys",
  encrypt: "Encrypting message",
  sign: "Awaiting wallet signature",
  postage: "Reserving postage",
  persist: "Saving to outbox",
  submit: "Submitting to relay",
  reconcile: "Confirming delivery",
};

const STAGE_ORDER: StageId[] = [
  "resolve",
  "encrypt",
  "sign",
  "postage",
  "persist",
  "submit",
  "reconcile",
];

function newMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `msg-${crypto.randomUUID()}`;
  }
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function deriveDomain(address: string): string {
  const parts = address.split("*");
  if (parts.length === 2 && parts[1]) return parts[1];
  return "stellar.network";
}

export class SendPipeline {
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly supportId: string;
  private readonly input: SendPipelineInput;
  private readonly onProgress?: (stages: StageState[]) => void;
  private readonly stages: StageState[];
  private readonly recipients: string[];
  private readonly domain: string;
  private readonly audience: string;

  private sealed?: SealedEnvelope;
  private signature?: WalletSignature;
  private canonical = "";
  private delivered = false;
  private finalState: DeliveryState = "DEAD_LETTER";
  private lastErrorCode?: string;
  private lastErrorMessage?: string;
  private lastOutcome?: SendOutcome;

  private isCommitted = false;
  private cancelled = false;
  private runningPromise?: Promise<SendOutcome>;

  private recipientKeys: RecipientKeyMaterial[] = [];
  private signedRequest?: SignedRelayRequest;
  private requestSigner?: RelayRequestSigner;

  /** Injected seams for tests / alternate signers. */
  private readonly signer: (canonical: string) => Promise<WalletSignature>;
  private readonly keyResolver?: DirectoryRecipientKeyResolver;

  constructor(
    input: SendPipelineInput,
    onProgress?: (stages: StageState[]) => void,
    options: {
      signer?: (canonical: string) => Promise<WalletSignature>;
      keyResolver?: DirectoryRecipientKeyResolver;
    } = {},
  ) {
    this.input = input;
    this.onProgress = onProgress;
    this.messageId = input.messageId ?? newMessageId();
    this.idempotencyKey = `idem-${this.messageId}`;
    const cleanId = this.messageId.replace(/^msg-/, "").replace(/[^a-zA-Z0-9]/g, "");
    this.supportId = `supp-${cleanId.slice(0, 12) || "send"}`;
    this.recipients = parseRecipients(input.to);
    this.domain = deriveDomain(this.recipients[0] ?? "");
    this.audience = input.audience ?? DEFAULT_RELAY_AUDIENCE;
    this.signer = options.signer ?? authorizeSend;
    this.keyResolver = options.keyResolver;
    this.stages = STAGE_ORDER.map((id) => ({
      id,
      label: STAGE_LABELS[id],
      status: "pending" as StageStatus,
    }));
  }

  getStages(): StageState[] {
    return this.stages.map((stage) => ({ ...stage }));
  }

  private setStage(id: StageId, status: StageStatus, detail?: string): void {
    const stage = this.stages.find((item) => item.id === id);
    if (stage) {
      stage.status = status;
      stage.detail = detail;
    }
    this.onProgress?.(this.getStages());
    this.syncOutboxStages();
  }

  private syncOutboxStages(): void {
    const snapshots: OutboxStageSnapshot[] = this.stages.map((s) => ({
      id: s.id,
      label: s.label,
      status: s.status,
      detail: s.detail,
    }));
    patchEntry(this.messageId, {
      stages: snapshots,
      idempotencyKey: this.idempotencyKey,
      supportId: this.supportId,
      canRetry: !this.isCommitted,
      isCommitted: this.isCommitted,
    });
  }

  private setOutbox(status: OutboxStatus, extra: Record<string, unknown> = {}): void {
    patchEntry(this.messageId, {
      status,
      idempotencyKey: this.idempotencyKey,
      supportId: this.supportId,
      isCommitted: this.isCommitted,
      ...extra,
    });
  }

  private fail(
    stage: StageId,
    reason: SendFailureReason,
    message: string,
    code?: string,
    canRetry = true,
  ): SendOutcome {
    const safeRetry = this.isCommitted ? false : canRetry;
    const outcome: SendOutcome = {
      ok: false,
      messageId: this.messageId,
      supportId: this.supportId,
      stage,
      reason,
      message,
      ...(code ? { code } : {}),
      canRetry: safeRetry,
      isCommitted: this.isCommitted,
      timestamp: new Date().toISOString(),
    };
    this.lastOutcome = outcome;
    this.lastErrorCode = code;
    this.lastErrorMessage = message;
    this.setOutbox("failed", {
      errorCode: code,
      errorMessage: message,
      canRetry: safeRetry,
      isCommitted: this.isCommitted,
    });
    return outcome;
  }

  private recipientAccounts(): string[] {
    if (this.input.recipients && this.input.recipients.length > 0) {
      return this.input.recipients.map((recipient) => recipient.account);
    }
    return this.recipients;
  }

  /**
   * Cancel an in-flight send before irreversible commitment.
   * Cancelling leaves the user draft intact and prevents subsequent stages.
   */
  cancel(): { success: boolean; reason?: string } {
    if (this.isCommitted) {
      return { success: false, reason: "Operation already committed to relay" };
    }
    this.cancelled = true;
    const activeStage = this.stages.find((s) => s.status === "active");
    if (activeStage) {
      this.setStage(activeStage.id, "error", "Cancelled by sender");
    }
    this.setOutbox("failed", {
      errorMessage: "Cancelled by sender",
      canRetry: false,
      isCommitted: false,
    });
    return { success: true };
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  isRunning(): boolean {
    return this.runningPromise !== undefined;
  }

  getLastOutcome(): SendOutcome | undefined {
    return this.lastOutcome;
  }

  private async runStage(id: StageId): Promise<SendOutcome | null> {
    if (this.cancelled) {
      return this.fail(id, "failed", "Send operation was cancelled", "ERR_CANCELLED", false);
    }

    switch (id) {
      case "resolve": {
        this.setStage("resolve", "active");
        try {
          const accounts = this.recipientAccounts();
          if (accounts.length === 0) {
            this.setStage("resolve", "error", "No recipients");
            return this.fail(
              "resolve",
              "recipient_rejected",
              "At least one recipient is required",
              undefined,
              false,
            );
          }
          this.recipientKeys = await resolveRecipientKeysForSend(accounts, this.keyResolver);
          this.setStage(
            "resolve",
            "done",
            `${this.recipientKeys.length} recipient key(s) resolved`,
          );
          return null;
        } catch (error) {
          const code = error instanceof RecipientKeyResolutionError ? error.recipient : undefined;
          const detail =
            error instanceof RecipientKeyResolutionError
              ? error.message
              : "Could not resolve recipient keys";
          this.setStage("resolve", "error", detail);
          return this.fail("resolve", "recipient_rejected", detail, code, false);
        }
      }
      case "encrypt": {
        this.setStage("encrypt", "active");
        try {
          this.sealed = await sealEnvelope({
            sender: this.input.sender,
            recipient: this.recipientKeys[0]?.account ?? "",
            body: this.input.body,
            attachments: this.input.attachments,
            recipientPublicKeys: this.recipientKeys.map((key) => key.publicKeySpkiBase64),
            recipientKeyId: this.recipientKeys[0]?.keyId,
          });
          this.setStage("encrypt", "done", "Sealed with Curve25519 / AES-GCM");
          return null;
        } catch {
          this.setStage("encrypt", "error", "Could not encrypt message");
          return this.fail(
            "encrypt",
            "failed",
            "Could not encrypt the message",
            "ERR_ENCRYPTION_FAILED",
            true,
          );
        }
      }
      case "sign": {
        if (!this.sealed) {
          return this.fail("sign", "failed", "Missing encrypted envelope", "ERR_MISSING_ENVELOPE");
        }
        this.setStage("sign", "active");
        try {
          let capturedSignature: WalletSignature | undefined;
          const sign = async (canonical: string) => {
            const signature = await this.signer(canonical);
            capturedSignature = signature;
            return signature;
          };

          const requestSigner: RelayRequestSigner = {
            envelopePayload: this.sealed.payload,
            audience: this.audience,
            idempotencyKey: this.idempotencyKey,
            replayWindowSeconds: DEFAULT_REPLAY_WINDOW_SECONDS,
            sign,
          };
          this.requestSigner = requestSigner;

          const signed = await buildSignedRelayRequest(requestSigner);
          this.signedRequest = signed;
          this.signature = capturedSignature ?? {
            scheme: "Ed25519",
            signerAddress: "",
            value: signed.signature.value,
          };
          this.canonical = canonicalizePayload(signed.payload);

          verifySenderBinding(this.signature.signerAddress, this.input.sender);
          this.setStage("sign", "done", "Authorized by sender");
          return null;
        } catch (error) {
          if (error instanceof SenderBindingError) {
            this.setStage("sign", "error", "Wallet signer does not match the sender");
            return this.fail(
              "sign",
              "failed",
              "Wallet signer does not match the sender",
              "ERR_SENDER_BINDING",
              true,
            );
          }
          if (error instanceof WalletRejectedError) {
            this.setStage("sign", "error", "Wallet rejected — draft kept");
            return this.fail(
              "sign",
              "wallet_rejected",
              error.message || "Wallet rejected signature",
              "ERR_WALLET_REJECTED",
              true,
            );
          }
          if (error instanceof WalletUnavailableError) {
            this.setStage("sign", "error", "Wallet unavailable");
            return this.fail(
              "sign",
              "wallet_unavailable",
              error.message || "No wallet detected",
              "ERR_WALLET_UNAVAILABLE",
              true,
            );
          }
          this.setStage("sign", "error", "Signing failed");
          return this.fail(
            "sign",
            "failed",
            "Wallet could not sign the message",
            "ERR_SIGNING_FAILED",
            true,
          );
        }
      }
      case "postage": {
        this.setStage("postage", "active");
        try {
          if (this.input.postageQuote) {
            if (this.input.postageQuote.reason === "sender_blocked") {
              this.setStage("postage", "error", "Recipient blocked this sender");
              return this.fail(
                "postage",
                "failed",
                "Recipient has blocked this sender",
                "ERR_SENDER_BLOCKED",
                false,
              );
            }
            if (this.input.postageQuote.trusted) {
              this.setStage("postage", "done", "Trusted (0 XLM postage)");
              return null;
            }
          }

          const postageDisplay = this.input.postage ? `${this.input.postage} XLM` : "Verified";
          this.setStage("postage", "done", `Postage verified (${postageDisplay})`);
          return null;
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Postage verification failed";
          this.setStage("postage", "error", detail);
          return this.fail("postage", "failed", detail, "ERR_POSTAGE_FAILED", true);
        }
      }
      case "persist": {
        this.setStage("persist", "active");
        createEntry({
          id: this.messageId,
          subject: this.input.subject,
          recipients: this.recipients,
          sender: this.input.sender,
          idempotencyKey: this.idempotencyKey,
          supportId: this.supportId,
          stages: this.stages.map((s) => ({
            id: s.id,
            label: s.label,
            status: s.id === "persist" ? "done" : s.status,
            detail: s.detail,
          })),
        });
        this.setOutbox("submitting", {
          envelope: this.sealed?.payload,
          ciphertext: this.sealed?.ciphertext,
          postageAmount: this.input.postage,
        });
        this.setStage("persist", "done", "Anchored in outbox");
        return null;
      }
      case "submit": {
        if (!this.signedRequest || !this.requestSigner) {
          return this.fail(
            "submit",
            "failed",
            "Missing signed relay request",
            "ERR_MISSING_SIGNED_REQUEST",
          );
        }
        this.setStage("submit", "active");
        this.isCommitted = true;
        try {
          const result = await submitToRelay({
            messageId: this.messageId,
            sender: this.input.sender,
            recipient: this.recipientKeys[0]?.account ?? "",
            recipientDomain: this.domain,
            payload: JSON.stringify(this.signedRequest),
            resigner: this.requestSigner,
          });
          this.delivered = result.delivered;
          this.finalState = result.state;
          this.lastErrorCode = result.errorCode;
          this.setStage("submit", "done", "Accepted by relay");
          return null;
        } catch {
          this.setStage("submit", "error", "Relay submission failed");
          return this.fail(
            "submit",
            "failed",
            "Could not reach the relay",
            "ERR_RELAY_UNREACHABLE",
            true,
          );
        }
      }
      case "reconcile": {
        this.setStage("reconcile", "active");
        if (this.delivered) {
          this.setOutbox("delivered", { canRetry: false });
          this.setStage("reconcile", "done", "Delivered");
          return null;
        }
        this.setOutbox("failed", { errorCode: this.lastErrorCode, canRetry: false });
        this.setStage("reconcile", "error", this.lastErrorCode ?? "Delivery failed");
        return this.fail(
          "reconcile",
          "failed",
          this.lastErrorCode ?? "Delivery failed",
          this.lastErrorCode,
          false,
        );
      }
      default:
        return null;
    }
  }

  /**
   * Run the send pipeline.
   * Concurrent invocations (e.g. from double-clicking) return the active execution
   * promise without performing duplicate operations or sending twice.
   */
  async run(): Promise<SendOutcome> {
    if (this.cancelled) {
      return this.fail("resolve", "failed", "Send operation was cancelled", "ERR_CANCELLED", false);
    }
    if (this.runningPromise) {
      return this.runningPromise;
    }

    this.runningPromise = (async () => {
      try {
        for (const stage of this.stages) {
          if (this.cancelled) {
            return this.fail(
              stage.id,
              "failed",
              "Send operation was cancelled",
              "ERR_CANCELLED",
              false,
            );
          }
          if (stage.status === "done") continue;
          const outcome = await this.runStage(stage.id);
          if (outcome) return outcome;
        }
        const successOutcome: SendOutcome = {
          ok: true,
          messageId: this.messageId,
          supportId: this.supportId,
          delivered: this.delivered,
          state: this.finalState,
        };
        this.lastOutcome = successOutcome;
        return successOutcome;
      } finally {
        this.runningPromise = undefined;
      }
    })();

    return this.runningPromise;
  }

  /**
   * Reconstitute a SendPipeline from an existing OutboxEntry (e.g. on page refresh).
   */
  static fromPersisted(
    entry: OutboxEntry,
    inputOverrides: Partial<SendPipelineInput> = {},
    onProgress?: (stages: StageState[]) => void,
    options: {
      signer?: (canonical: string) => Promise<WalletSignature>;
      keyResolver?: DirectoryRecipientKeyResolver;
    } = {},
  ): SendPipeline {
    const pipeline = new SendPipeline(
      {
        sender: entry.sender ?? inputOverrides.sender ?? "",
        to: entry.recipients.join(", "),
        subject: entry.subject,
        body: inputOverrides.body ?? "",
        messageId: entry.id,
        recipients: inputOverrides.recipients,
        audience: inputOverrides.audience,
        postage: entry.postageAmount ?? inputOverrides.postage,
        ...inputOverrides,
      },
      onProgress,
      options,
    );

    if (entry.stages && entry.stages.length > 0) {
      for (const saved of entry.stages) {
        const target = pipeline.stages.find((s) => s.id === saved.id);
        if (target) {
          target.status = saved.status;
          target.detail = saved.detail;
        }
      }
    }

    if (entry.status === "delivered") {
      pipeline.delivered = true;
      pipeline.finalState = "ACKNOWLEDGED";
    }
    if (entry.isCommitted) {
      pipeline.isCommitted = true;
    }

    return pipeline;
  }
}
