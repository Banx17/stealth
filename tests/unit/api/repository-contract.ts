import { beforeEach, describe, expect, it } from "vitest";

import type { StoredEnvelope } from "../../../src/server/api/domain";
import type { ApiRepository } from "../../../src/server/api/repository";

// Issue #1494: one reusable repository conformance suite that every adapter must
// satisfy, so memory and future production adapters cannot diverge on CRUD,
// ordering, conflict, and not-found semantics.
//
// `makeRepository` is an async factory so adapter-specific setup (connections,
// migrations, fixtures) is injected without changing the expected behavior.
export function runRepositoryContractTests(
  adapterName: string,
  makeRepository: () => Promise<ApiRepository> | ApiRepository,
) {
  const owner = `G${"A".repeat(55)}`;
  const sender = `G${"B".repeat(55)}`;
  const messageId = "a".repeat(64);
  const paymentHash = "b".repeat(64);

  describe(`ApiRepository contract: ${adapterName}`, () => {
    let repo: ApiRepository;

    beforeEach(async () => {
      repo = await makeRepository();
    });

    describe("policy CRUD", () => {
      it("returns null for a missing policy", async () => {
        await expect(repo.getPolicy(owner)).resolves.toBeNull();
      });

      it("round-trips a stored policy", async () => {
        await repo.setPolicy(owner, {
          allowUnknown: true,
          minimumPostage: "100",
          requireVerified: false,
        });
        await expect(repo.getPolicy(owner)).resolves.toMatchObject({
          allowUnknown: true,
          minimumPostage: "100",
          requireVerified: false,
        });
      });

      it("overwrites an existing policy on repeated set", async () => {
        await repo.setPolicy(owner, {
          allowUnknown: true,
          minimumPostage: "100",
          requireVerified: false,
        });
        await repo.setPolicy(owner, {
          allowUnknown: false,
          minimumPostage: "200",
          requireVerified: true,
        });
        await expect(repo.getPolicy(owner)).resolves.toMatchObject({
          minimumPostage: "200",
          requireVerified: true,
        });
      });
    });

    describe("sender rules", () => {
      it("defaults to 'default' when no rule exists", async () => {
        await expect(repo.getSenderRule(owner, sender)).resolves.toBe("default");
      });

      it("stores and clears explicit rules", async () => {
        await repo.setSenderRule(owner, sender, "allow");
        await expect(repo.getSenderRule(owner, sender)).resolves.toBe("allow");

        await repo.setSenderRule(owner, sender, "default");
        await expect(repo.getSenderRule(owner, sender)).resolves.toBe("default");
      });

      it("isolates rules per (owner, sender) pair", async () => {
        const otherSender = `G${"C".repeat(55)}`;
        await repo.setSenderRule(owner, sender, "block");
        await expect(repo.getSenderRule(owner, otherSender)).resolves.toBe("default");
      });
    });

    describe("postage and receipt records", () => {
      it("returns null for missing postage and receipts", async () => {
        await expect(repo.getPostage(messageId)).resolves.toBeNull();
        await expect(repo.getReceipt(messageId)).resolves.toBeNull();
      });

      it("round-trips postage keyed by messageId", async () => {
        await repo.setPostage({
          amount: "100",
          createdAt: "2026-01-01T00:00:00.000Z",
          messageId,
          paymentHash,
          recipient: owner,
          sender,
          status: "pending",
        });
        await expect(repo.getPostage(messageId)).resolves.toMatchObject({
          messageId,
          status: "pending",
        });
      });

      it("round-trips receipts keyed by messageId", async () => {
        await repo.setReceipt({
          deliveredAt: "2026-01-01T00:00:00.000Z",
          messageId,
          readAt: null,
          recipient: owner,
          sender,
        });
        await expect(repo.getReceipt(messageId)).resolves.toMatchObject({
          messageId,
          readAt: null,
        });
      });
    });

    describe("atomic postage transitions", () => {
      it("reports not-found for a message with no postage", async () => {
        await expect(repo.transitionPostage(messageId, "pending", "settled")).resolves.toEqual({
          outcome: "not-found",
        });
      });

      it("applies a pending -> settled transition and reflects it in getPostage", async () => {
        await repo.setPostage({
          amount: "100",
          createdAt: "2026-01-01T00:00:00.000Z",
          messageId,
          paymentHash,
          recipient: owner,
          sender,
          status: "pending",
        });

        const result = await repo.transitionPostage(messageId, "pending", "settled");
        expect(result).toMatchObject({ outcome: "applied", postage: { status: "settled" } });
        await expect(repo.getPostage(messageId)).resolves.toMatchObject({ status: "settled" });
      });

      it("reports a conflict with the current status when already terminal", async () => {
        await repo.setPostage({
          amount: "100",
          createdAt: "2026-01-01T00:00:00.000Z",
          messageId,
          paymentHash,
          recipient: owner,
          sender,
          status: "settled",
        });

        await expect(
          repo.transitionPostage(messageId, "pending", "settled"),
        ).resolves.toMatchObject({ outcome: "conflict", postage: { status: "settled" } });
      });

      it("allows exactly one winner out of concurrent settlement attempts", async () => {
        await repo.setPostage({
          amount: "100",
          createdAt: "2026-01-01T00:00:00.000Z",
          messageId,
          paymentHash,
          recipient: owner,
          sender,
          status: "pending",
        });

        const results = await Promise.all(
          Array.from({ length: 5 }, () => repo.transitionPostage(messageId, "pending", "settled")),
        );

        const applied = results.filter((result) => result.outcome === "applied");
        const conflicts = results.filter((result) => result.outcome === "conflict");
        expect(applied).toHaveLength(1);
        expect(conflicts).toHaveLength(4);
        await expect(repo.getPostage(messageId)).resolves.toMatchObject({ status: "settled" });
      });
    });

    describe("idempotency records", () => {
      it("returns null for a missing idempotency key", async () => {
        await expect(repo.getIdempotencyRecord("missing")).resolves.toBeNull();
      });

      it("round-trips an idempotency record", async () => {
        await repo.setIdempotencyRecord("key-1", {
          state: "completed",
          status: 200,
          body: { ok: true },
          requestDigest: "digest-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
        });
        await expect(repo.getIdempotencyRecord("key-1")).resolves.toMatchObject({
          status: 200,
        });
      });

      // Issue #1498: acquiring a lease binds it to a canonical request digest,
      // so a same-key-different-payload retry never blocks behind or replays
      // an unrelated request's response.
      it("acquires, blocks concurrent followers, and replays the completed response", async () => {
        const acquired = await repo.acquireIdempotencyRecord("key-2", "digest-a", 30_000);
        expect(acquired).toEqual({ status: "acquired" });

        const inProgress = await repo.acquireIdempotencyRecord("key-2", "digest-a", 30_000);
        expect(inProgress).toEqual({ status: "in_progress" });

        await repo.setIdempotencyRecord("key-2", {
          state: "completed",
          status: 200,
          body: { ok: true },
          requestDigest: "digest-a",
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
        });

        const completed = await repo.acquireIdempotencyRecord("key-2", "digest-a", 30_000);
        expect(completed).toMatchObject({ status: "completed", record: { body: { ok: true } } });
      });

      it("returns conflict when the same key is reused with a different payload digest", async () => {
        await repo.acquireIdempotencyRecord("key-3", "digest-a", 30_000);

        const conflict = await repo.acquireIdempotencyRecord("key-3", "digest-b", 30_000);
        expect(conflict).toEqual({ status: "conflict" });
      });

      it("only lets one of many concurrent duplicate acquires win", async () => {
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            repo.acquireIdempotencyRecord("key-4", "digest-a", 30_000),
          ),
        );

        const acquired = results.filter((result) => result.status === "acquired");
        const inProgress = results.filter((result) => result.status === "in_progress");
        expect(acquired).toHaveLength(1);
        expect(inProgress).toHaveLength(4);
      });
    });

    describe("counters", () => {
      it("starts at zero and increments within a window", async () => {
        await expect(repo.getCounter("rl:test")).resolves.toBe(0);
        const first = await repo.incrementCounter("rl:test", 60);
        const second = await repo.incrementCounter("rl:test", 60);
        expect(first).toBe(1);
        expect(second).toBe(2);
      });
    });

    describe("stored values are isolated from caller mutation", () => {
      it("does not reflect post-write mutation of the input object", async () => {
        const policy = {
          allowUnknown: true,
          minimumPostage: "100",
          requireVerified: false,
        };
        await repo.setPolicy(owner, policy);
        policy.minimumPostage = "999";
        await expect(repo.getPolicy(owner)).resolves.toMatchObject({
          minimumPostage: "100",
        });
      });
    });

    // -------------------------------------------------------------------------
    // Issue #1936 (BETA-029) — Envelope persistence contract
    // Every ApiRepository adapter must satisfy these invariants.
    // -------------------------------------------------------------------------

    describe("encrypted envelope persistence (BETA-029 / Issue #1936)", () => {
      const ephemeralKey = `G${"C".repeat(55)}`;
      const envMessageId = "e".repeat(64);
      const envMessageId2 = "f".repeat(64);
      const commitment = "c".repeat(64);
      const mac = "d".repeat(64);
      const nonce = "ab12cd34ef56";

      function makeEnvelope(overrides: Partial<StoredEnvelope> = {}): StoredEnvelope {
        return {
          messageId: envMessageId,
          senderId: sender,
          recipientId: owner,
          ciphertext: "dGVzdC1jaXBoZXJ0ZXh0",
          protectedHeaders: {
            algorithm: "AES-256-GCM",
            ephemeral_public_key: ephemeralKey,
            nonce,
            mac,
            version: "v1",
          },
          contentCommitment: commitment,
          createdAt: "2026-01-01T00:00:00.000Z",
          ...overrides,
        };
      }

      it("returns null for a missing envelope", async () => {
        await expect(repo.getEnvelope(envMessageId)).resolves.toBeNull();
      });

      it("returns 'inserted' on the first insert and retrieves the record", async () => {
        const envelope = makeEnvelope();
        const result = await repo.insertEnvelope(envelope);
        expect(result.outcome).toBe("inserted");

        const retrieved = await repo.getEnvelope(envMessageId);
        expect(retrieved).not.toBeNull();
        expect(retrieved?.messageId).toBe(envMessageId);
        expect(retrieved?.senderId).toBe(sender);
        expect(retrieved?.recipientId).toBe(owner);
        // Plaintext must never appear in the retrieved record.
        expect((retrieved as any)?.subject).toBeUndefined();
        expect((retrieved as any)?.body).toBeUndefined();
      });

      it("returns 'duplicate' for a byte-identical resubmission (idempotent)", async () => {
        const envelope = makeEnvelope();
        await repo.insertEnvelope(envelope);

        const retry = await repo.insertEnvelope({ ...envelope });
        expect(retry.outcome).toBe("duplicate");
        if (retry.outcome === "duplicate") {
          expect(retry.envelope.messageId).toBe(envMessageId);
        }
      });

      it("returns 'conflict' when a different payload uses the same messageId", async () => {
        await repo.insertEnvelope(makeEnvelope());
        const different = makeEnvelope({ ciphertext: "ZGlmZmVyZW50AA==" });
        const result = await repo.insertEnvelope(different);
        expect(result.outcome).toBe("conflict");
      });

      it("allows exactly one winner out of 5 concurrent inserts", async () => {
        const envelope = makeEnvelope();
        const results = await Promise.all(
          Array.from({ length: 5 }, () => repo.insertEnvelope({ ...envelope })),
        );

        const inserted = results.filter((r) => r.outcome === "inserted");
        const duplicates = results.filter((r) => r.outcome === "duplicate");
        const conflicts = results.filter((r) => r.outcome === "conflict");

        expect(inserted).toHaveLength(1);
        expect(duplicates).toHaveLength(4);
        expect(conflicts).toHaveLength(0);
      });

      it("isolates envelopes by messageId", async () => {
        await repo.insertEnvelope(makeEnvelope({ messageId: envMessageId }));
        await repo.insertEnvelope(makeEnvelope({ messageId: envMessageId2 }));

        await expect(repo.getEnvelope(envMessageId)).resolves.toMatchObject({
          messageId: envMessageId,
        });
        await expect(repo.getEnvelope(envMessageId2)).resolves.toMatchObject({
          messageId: envMessageId2,
        });
      });

      it("is insert-only: a different ciphertext cannot overwrite the stored record", async () => {
        const original = makeEnvelope();
        await repo.insertEnvelope(original);

        await repo.insertEnvelope(makeEnvelope({ ciphertext: "bmV3Y2lwaGVydGV4dA==" }));

        const stored = await repo.getEnvelope(envMessageId);
        expect(stored?.ciphertext).toBe(original.ciphertext);
      });
    });
  });
}
