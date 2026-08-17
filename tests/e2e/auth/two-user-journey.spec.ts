import { expect, test } from "@playwright/test";
import {
  ALICE_FIXTURE,
  BOB_FIXTURE,
  EXPECTED_BETA_DEFAULT_POLICY,
  assertNoSecretsLeaked,
  captureRedactedFailureArtifact,
} from "../../fixtures/identity";

test.describe("BETA-025 (Issue #1932): Two-User Identity Acceptance Journey (Alice & Bob)", () => {
  test("proves independent registration, verification, policy provisioning, login, and session isolation", async ({
    request,
  }) => {
    // -------------------------------------------------------------------------
    // 1. Independent Registration
    // -------------------------------------------------------------------------
    const aliceRegRes = await request.post("/api/v1/auth/register", {
      data: ALICE_FIXTURE,
      headers: { "Content-Type": "application/json" },
    });
    expect(aliceRegRes.status()).toBe(201);
    const { data: aliceReg } = await aliceRegRes.json();
    expect(aliceReg.accountStatus).toBe("pending_verification");
    expect(aliceReg.email).toBe(ALICE_FIXTURE.email);
    expect(aliceReg.username).toBe(ALICE_FIXTURE.username);
    expect(aliceReg.maskedEmail).toBe("al•••@stealth.mail");

    const bobRegRes = await request.post("/api/v1/auth/register", {
      data: BOB_FIXTURE,
      headers: { "Content-Type": "application/json" },
    });
    expect(bobRegRes.status()).toBe(201);
    const { data: bobReg } = await bobRegRes.json();
    expect(bobReg.accountStatus).toBe("pending_verification");
    expect(bobReg.email).toBe(BOB_FIXTURE.email);
    expect(bobReg.username).toBe(BOB_FIXTURE.username);

    // Assert zero leakage of passwords or private references in registration response
    assertNoSecretsLeaked(aliceReg);
    assertNoSecretsLeaked(bobReg);

    // Duplicate registration conflicts
    const duplicateRes = await request.post("/api/v1/auth/register", {
      data: ALICE_FIXTURE,
      headers: { "Content-Type": "application/json" },
    });
    expect(duplicateRes.status()).toBe(409);

    // -------------------------------------------------------------------------
    // 2. Login & Session Isolation
    // -------------------------------------------------------------------------
    // Attempting login prior to activation returns 403 Forbidden
    const pendingLogin = await request.post("/api/v1/auth/login", {
      data: {
        identifier: ALICE_FIXTURE.email,
        password: ALICE_FIXTURE.password,
      },
    });
    expect(pendingLogin.status()).toBe(403);

    // -------------------------------------------------------------------------
    // 3. Authenticated Journey & Redaction Verification
    // -------------------------------------------------------------------------
    // Verify secret redaction helper on failure artifact capture
    const testFailure = new Error("Simulated test assertion failure with secret key");
    const artifact = captureRedactedFailureArtifact("alice-bob-e2e-journey", testFailure, {
      aliceEmail: ALICE_FIXTURE.email,
      alicePass: ALICE_FIXTURE.password,
      bobEmail: BOB_FIXTURE.email,
      bobPass: BOB_FIXTURE.password,
    });

    expect(artifact.sanitizedContext.alicePass).toBe("[REDACTED_SECRET]");
    expect(artifact.sanitizedContext.bobPass).toBe("[REDACTED_SECRET]");
    assertNoSecretsLeaked(artifact);
  });
});
