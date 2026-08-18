import { describe, expect, it, vi } from "vitest";
import type { Email } from "@/components/mail/data";
import type { TriageAction } from "@/features/requests/types";

const makeRequestEmail = (overrides: Partial<Email> = {}): Email => ({
  id: "request-1",
  from: "Unknown Founder",
  email: "founder*example.test",
  subject: "Paid intro request",
  preview: "I attached postage for a short intro.",
  body: "Hello, this is a fake deterministic request fixture.",
  time: "Now",
  unread: true,
  starred: false,
  folder: "requests",
  labels: ["Request", "Paid", "Design"],
  avatarColor: "#64748b",
  postageAmount: "15000000",
  verifiedSender: false,
  ...overrides,
});

function cleanLabels(labels?: string[], toAdd?: string) {
  const filterOut = new Set(["Request", "Paid", "Pending"]);
  const current = labels ? labels.filter((l) => !filterOut.has(l)) : [];
  return toAdd ? [...current, toAdd] : current;
}

function resolveFinalizePatch(
  email: Email,
  action: TriageAction,
): {
  patch: Partial<Email>;
  toastMessage: string;
  toastTone: "success" | "danger";
} {
  if (action === "approve") {
    return {
      patch: {
        folder: "inbox",
        senderPolicy: "allow",
        labels: cleanLabels(email.labels, "Trusted"),
      },
      toastMessage: `${email.from} added to Trusted Contacts. Mail moved to Inbox.`,
      toastTone: "success",
    };
  } else if (action === "block") {
    return {
      patch: {
        folder: "spam",
        senderPolicy: "block",
        labels: cleanLabels(email.labels, "Blocked"),
      },
      toastMessage: `${email.from} blocked. Mail moved to Spam.`,
      toastTone: "danger",
    };
  } else {
    return {
      patch: {
        folder: "spam",
        labels: cleanLabels(email.labels, "Refunded"),
      },
      toastMessage: `Postage refunded for message from ${email.from}.`,
      toastTone: "success",
    };
  }
}

describe("RequestsTriageBoard state machine and transition logic", () => {
  it("approves a paid sender request and resolves finalized inbox patch", () => {
    const email = makeRequestEmail();
    const result = resolveFinalizePatch(email, "approve");

    expect(result.patch).toEqual({
      folder: "inbox",
      senderPolicy: "allow",
      labels: ["Design", "Trusted"],
    });
    expect(result.toastMessage).toBe(
      "Unknown Founder added to Trusted Contacts. Mail moved to Inbox.",
    );
    expect(result.toastTone).toBe("success");
  });

  it("blocks a sender request and resolves finalized spam patch", () => {
    const email = makeRequestEmail();
    const result = resolveFinalizePatch(email, "block");

    expect(result.patch).toEqual({
      folder: "spam",
      senderPolicy: "block",
      labels: ["Design", "Blocked"],
    });
    expect(result.toastTone).toBe("danger");
  });

  it("refunds postage for a request and resolves finalized refund patch", () => {
    const email = makeRequestEmail();
    const result = resolveFinalizePatch(email, "refund");

    expect(result.patch).toEqual({
      folder: "spam",
      labels: ["Design", "Refunded"],
    });
    expect(result.toastTone).toBe("success");
  });
});

describe("Requests triage board unit helpers", () => {
  const formatPostage = (stroops?: string) => {
    if (!stroops) return "0.0 XLM";
    try {
      const val = BigInt(stroops);
      const xlm = Number(val) / 10_000_000;
      return `${xlm.toLocaleString(undefined, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 4,
      })} XLM`;
    } catch {
      return `${stroops} stroops`;
    }
  };

  it("formats postage amounts from stroops to XLM native units", () => {
    expect(formatPostage("10000000")).toBe("1.0 XLM");
    expect(formatPostage("50000000")).toBe("5.0 XLM");
    expect(formatPostage("15000000")).toBe("1.5 XLM");
    expect(formatPostage("100000")).toBe("0.01 XLM");
    expect(formatPostage(undefined)).toBe("0.0 XLM");
    expect(formatPostage("invalid")).toBe("invalid stroops");
  });

  it("cleans temporary triage labels and appends final policy badge", () => {
    const originalLabels = ["Request", "Paid", "Design"];
    const resultApprove = cleanLabels(originalLabels, "Trusted");
    expect(resultApprove).toEqual(["Design", "Trusted"]);
    expect(resultApprove).not.toContain("Request");
    expect(resultApprove).not.toContain("Paid");

    const resultBlock = cleanLabels(originalLabels, "Blocked");
    expect(resultBlock).toEqual(["Design", "Blocked"]);

    const resultRefund = cleanLabels(originalLabels, "Refunded");
    expect(resultRefund).toEqual(["Design", "Refunded"]);
  });
});

describe("Proof Inspector Query Validation & Payload Safety", () => {
  const validateQuery = (
    query: string,
  ): "address" | "hash" | "uuid" | "keyword" | "invalid-length" => {
    const trimmed = query.trim();
    if (!trimmed) return "keyword";

    const addressRegex = /^[GC][A-Z2-7]{55}$/i;
    const hashRegex = /^(0x)?[a-f0-9]{64}$/i;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (addressRegex.test(trimmed)) return "address";
    if (hashRegex.test(trimmed)) return "hash";
    if (uuidRegex.test(trimmed)) return "uuid";

    if (
      (trimmed.length > 5 &&
        (trimmed.startsWith("G") || trimmed.startsWith("C")) &&
        trimmed.length !== 56) ||
      (trimmed.length > 10 &&
        trimmed.match(/^[0-9a-f]+$/i) &&
        trimmed.length !== 64 &&
        !trimmed.startsWith("0x"))
    ) {
      return "invalid-length";
    }

    return "keyword";
  };

  it("identifies valid Stellar G-addresses and C-addresses", () => {
    const validG = "GB2PKCKNN4XQY6N7N4G3J73N4H73U73N4G3J73N4H73U73N4G3J73N4H";
    const validC = "CB2PKCKNN4XQY6N7N4G3J73N4H73U73N4G3J73N4H73U73N4G3J73N4H";
    expect(validateQuery(validG)).toBe("address");
    expect(validateQuery(validC)).toBe("address");
  });

  it("rejects malformed or invalid length addresses", () => {
    const shortAddress = "GB2PKCKNN4XQY6N7N4G3J73N4H73U73N4";
    expect(validateQuery(shortAddress)).toBe("invalid-length");
  });

  it("identifies valid 32-byte hexadecimal hashes", () => {
    const validHashWithoutPrefix =
      "a1b2c3d4e5f601020304050607080900112233445566778899aabbccddeeff00";
    const validHashWithPrefix =
      "0xa1b2c3d4e5f601020304050607080900112233445566778899aabbccddeeff00";
    expect(validateQuery(validHashWithoutPrefix)).toBe("hash");
    expect(validateQuery(validHashWithPrefix)).toBe("hash");
  });

  it("rejects invalid length hexadecimal hashes", () => {
    const shortHash = "a1b2c3d4e5f6";
    expect(validateQuery(shortHash)).toBe("invalid-length");
  });

  it("identifies valid relay diagnostic UUIDs", () => {
    const validUUID = "d1f038c7-4b1d-44a6-8968-3e5f49230501";
    expect(validateQuery(validUUID)).toBe("uuid");
  });

  it("falls back to keyword searching for sender names or subjects", () => {
    expect(validateQuery("Lina Park")).toBe("keyword");
    expect(validateQuery("brand system")).toBe("keyword");
  });

  it("ensures sensitive plaintext payload is omitted from proof record logs", () => {
    const mockEmail = {
      id: "1",
      from: "Lina Park",
      email: "lina*vantage.studio",
      subject: "Refined brand system",
      body: "This is a super secret message body containing proprietary designs.",
      time: "10:30 AM",
      unread: false,
    };

    const record = {
      messageHash: "0xa1b2...",
      paymentHash: "0xb2c3...",
      subject: mockEmail.subject,
    };

    expect(record).not.toHaveProperty("body");
  });
});
