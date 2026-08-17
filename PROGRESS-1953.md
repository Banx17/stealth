# Session Continuation — BETA-046 (#1953) Send Pipeline

> **How to use this file:** This is the single source of truth for resuming work.
> Start a new session by reading this file, then `issue1953.md` for the full task
> spec. Do NOT re-explore what is already recorded here.

## Status: IMPLEMENTED + UNIT-TESTED, E2E NOT YET VERIFIED

- Branch: `feat/issue-1953-beta-046-send-pipeline` (based on `main`).
- All implementation and unit tests are committed. E2E specs are written and
  committed but **have NOT run to green yet** (see Remaining).
- `issue1953.md` is still present and **untracked** (do not commit it yet — it is
  deleted as the final step).

---

## Objective

Complete BETA-046 (#1953): the live compose send pipeline — fetch + validate
recipient keys from the versioned public key directory, encrypt/sign/seal one
canonical relay envelope, submit to the real relay accept endpoint with
structured progress and recoverable error stages.

## Decisions locked in (user-confirmed)

1. **Attachments: keep inline.** Existing envelope inline attachment path is
   used; the BETA-031 client resumable-upload route is out of scope. Attachment
   bytes are covered by unit tests + golden vectors, not the browser e2e. Note:
   `Attachment` in `composeValidation.ts` is display-only `{name,size,type}`, so
   `attachments` in `SendPipelineInput` cannot be populated from the UI yet.
2. **Wrong-network = binding + importability.** Keys are rejected when not bound
   to the resolved recipient (owner != resolved account) or when they fail
   P-256 ECDH SPKI import. No schema/network-field changes.
3. Canonical relay request per `docs/protocol/relay-auth-replay.md`: envelope
   payload + `request_nonce`, `audience`, `idempotency_key`,
   `replay_window_seconds`, Ed25519 signature over `jcs(payload)`.

---

## DONE — Files implemented

### New files
- `src/services/crypto/sendRecipientValidation.ts` — domain rejection rules.
  `SendRecipientRejection` codes: `revoked | expired | not_yet_valid |
  unsupported_algorithm | wrong_network | unresolved`. `RecipientKeyMaterial`,
  `RecipientKeyRejectedError`, `classifyResolverFailure()`,
  `recipientKeyToMaterial()` (re-asserts binding/lifecycle, validates the key
  imports as P-256 ECDH SPKI via `importRecipientPublicKey`).
- `src/features/compose/recipientKeyResolution.ts` — client bridge to the key
  directory. `fetchKeyDirectory(owner)` → `GET /api/v1/identity/keys/?owner=`,
  `createKeyDirectoryResolver()`, `resolveRecipientKeyForSend()`,
  `resolveRecipientKeysForSend()` (dedup by account, cap
  `MAX_RECIPIENT_KEYS`), `RecipientKeyResolutionError`.
- `protocol/vectors/envelope-send.json` — golden-vector fixture for the
  multi-recipient send envelope (fixed sender/recipients/unicode body/
  attachment descriptor + structural invariants).
- `tests/unit/protocol/envelope-send.test.ts` — drives the fixture through
  `sealEnvelope` + `openEnvelope`/`WrappedKeyProvider`: one wrapped-key entry
  per recipient, every recipient unwraps the same Unicode body, tamper matrix
  (ciphertext / wrapped-key / non-recipient) fails closed. **Passing.**
- `tests/unit/crypto/sendRecipientValidation.test.ts` — validation boundary.
  **Passing.**
- `tests/unit/relay/client-submit.test.ts` — `submitToRelay` state mapping:
  ACKNOWLEDGED, DEDUPLICATED (409), DEAD_LETTER + actionable codes,
  transient 5xx retry with **fresh nonce**, network-error retry,
  ERR_DOMAIN_NOT_FOUND, signed-request anti-replay fields, nonce uniqueness.
  **Passing.**
- `tests/unit/compose/sendPipeline.test.ts` — full staged pipeline with injected
  seams: happy path (2 recipients), each rejection scenario, wallet
  rejected/unavailable, sender-binding failure, 409 idempotent success, re-sign
  with fresh nonce on 503, empty recipient list, stage progress order.
  **Passing.**
- `tests/e2e/send-pipeline.spec.ts` — NEW e2e: two G-address recipients +
  Unicode body seals/signs/submits; recoverable error shown when a recipient
  key is missing. Stubs wallet seam (`__freighterApi`), relay diagnostics, relay
  accept POST, and key directory (real P-256 keys generated in Node).
  **Written, NOT yet run to green.**

### Modified files
- `src/services/relay/submit.ts` — REWRITTEN. Real `defaultRelayTransport`
  (fetch POST to `node.endpoint` with `x-stealth-address` header),
  `buildSignedRelayRequest(signer, nonce?)`, `generateRequestNonce()` (16
  random bytes hex), `submitToRelay` with bounded retries
  (`DEFAULT_MAX_ATTEMPTS=3`, backoff 250ms→2s, first attempt = caller's signed
  request, retries re-sign via `resigner` with fresh nonce + stable
  `idempotency_key = idem-${messageId}`). Constants
  `DEFAULT_RELAY_AUDIENCE="relay:stealth.test"`,
  `DEFAULT_REPLAY_WINDOW_SECONDS=300`. New input shape
  `{messageId, sender, recipient, recipientDomain, payload, ttlMs?, maxAttempts?, resigner?}`
  (callers updated). Exports `RelayResolver`, `RelayTransport`, `RelaySubmitInput`,
  `RelaySubmitResult`, `RelayRequestSigner`, `SignedRelayRequest`,
  `RelayRequestPayload`, `RelaySubmissionBody`.
- `src/relay/index.ts` — updated `submitToRelay` call to pass `sender`,
  `recipient`, `payload` from `RelayEnvelope` (keeps its own transport option).
- `src/features/compose/sendPipeline.ts` — REWRITTEN. Added `resolve` stage
  (`StageId` union, `STAGE_LABELS`, `STAGE_ORDER`); `SendFailureReason` +=
  `"recipient_rejected"`; failure outcome gains `code?`; input gains
  `recipients?: SendPipelineRecipient[]` (`{address, account}`) and `audience?`;
  constructor gains `options: { signer?, keyResolver? }`; sign stage builds the
  canonical relay request via `buildSignedRelayRequest` and enforces
  `verifySenderBinding(signature.signerAddress, input.sender)`; submit passes
  `JSON.stringify(signedRequest)` + `resigner`; `recipientAccounts()` falls back
  to parsed addresses; `recipient`/`recipientPublicKeys`/`recipientKeyId` wired
  from `this.recipientKeys` (first key = primary recipient, all keys wrapped).
- `src/components/mail/Compose.tsx` — `handleSend` now resolves the real sender
  via `resolveSenderAddress()` (fallback `"me"` when no wallet) and passes
  `recipients` mapped from `resolvedRecipients` (verified/unknown states,
  `account = resolvedAccount ?? address`).
- `src/services/stellar/wallet.ts` — added `resolveSenderAddress()`: reads the
  same `__freighterApi` seam as `authorizeSend`, returns the wallet address or
  `null` (production still talks to real Freighter).
- `src/services/crypto/key-resolver.ts` — `toResolvedKey` now decodes
  hex/base64 with `codec.ts` (`fromHex`/`fromBase64`) instead of `Buffer`, so
  the key-directory fetch works in the browser bundle.
- `src/services/crypto/open-envelope.ts` — FIXED a latent bug: commitment
  mismatch now maps to `crypto_integrity_error` by checking the structured
  `err.code === "crypto_commitment_error"` (the old message-substring check
  failed because `CryptoError.message` is a fixed public string without
  "mismatch"). Exposed by the tamper-matrix vector test.
- `tests/e2e/compose.spec.ts` — updated: send test uses a single G-address
  recipient; `beforeEach` now stubs key directory + relay accept POST in
  addition to diagnostics + wallet. Schedule/validation tests unchanged.

---

## Verification so far (ALL GREEN)

- `npx tsc --noEmit` → clean.
- `npx eslint --fix` on all touched files → clean (0 errors).
- `npm test` (vitest `tests/unit`) → **187 files, 2176 passed, 3 expected fail**.
  Includes the 4 new test files above.

## Remaining

### 1. Run e2e to green (HIGH — this is where we stopped)
- The Playwright Chromium binary was corrupt (`spawn EFTYPE`); reinstalled via
  `npx playwright install chromium` and verified
  `chrome-headless-shell.exe --version` works. The previous targeted run was
  aborted by the user BEFORE tests executed.
- Run: `npx playwright test tests/e2e/send-pipeline.spec.ts tests/e2e/compose.spec.ts`
  (webServer auto-starts via `bun run dev`; `reuseExistingServer`).
- Fix any failures. Watch out for:
  - **Sender binding in e2e:** `Compose.handleSend` uses `resolveSenderAddress()`
    which reads the `__freighterApi` seam (returns `DEMO_SIGNER`), and
    `authorizeSend` signs with the same seam — the pipeline's
    `verifySenderBinding` must pass.
  - **Key-directory stub routing:** pattern `**/api/v1/identity/keys/**` must
    match the query URL `/api/v1/identity/keys/?owner=...`; the stub keys by
    `searchParams.get("owner")`.
  - **`useFreighter` reads real `@stellar/freighter-api`** (not the seam), so
    `senderAddress` stays `"me"` — that's fine because `handleSend` overrides it
    with `resolveSenderAddress()`.
- After green, consider running the full e2e suite if time permits
  (`npx playwright test`).

### 2. Final commit steps (HIGH)
- Delete `issue1953.md` (it is untracked; it is the task spec and is kept only
  until implementation is fully complete).
- `git add .` and commit on `feat/issue-1953-beta-046-send-pipeline`.

### 3. Optional follow-ups (if in scope later)
- Populate `SendPipelineInput.attachments` from the UI (currently display-only
  `Attachment` type, so the pipeline's `attachments` option is not fed by
  Compose).
- Full e2e suite run + CI.

---

## Todo list (mirror of the session tracker)

**Completed**
1. Create git branch `feat/issue-1953-beta-046-send-pipeline`.
2. `sendRecipientValidation.ts` (domain rejection rules).
3. `recipientKeyResolution.ts` (client key-directory resolver).
4. Rewrite `src/services/relay/submit.ts`.
5. Update `src/relay/index.ts`.
6. Rewrite `src/features/compose/sendPipeline.ts`.
7. `key-resolver.ts` Buffer-free (`toResolvedKey`).
8. `resolveSenderAddress()` in `wallet.ts`.
9. Compose.tsx wiring (real sender + recipients).
10. Golden vectors + envelope-send test (+ open-envelope commitment-code fix).
11. Unit tests (sendPipeline, client-submit, sendRecipientValidation).
12. E2E specs written (`send-pipeline.spec.ts` new; `compose.spec.ts` updated).

**In progress**
13. E2E specs written but NOT run to green (browser was reinstalled; run was
    aborted before tests executed).

**Pending**
14. Run targeted e2e to green.
15. Delete `issue1953.md`, final `git add .` + commit on branch.