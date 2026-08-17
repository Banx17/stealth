import { z } from "zod";

export const stellarAddressSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^G[A-Z2-7]{55}$/, "Expected a Stellar G-address");

export const hash32Schema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{64}$/, "Expected a 32-byte lowercase hexadecimal hash");

export const stroopAmountSchema = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d*)$/, "Expected a non-negative integer string")
  .refine((value) => {
    try {
      return BigInt(value) <= 2n ** 127n - 1n;
    } catch {
      return false;
    }
  }, "Amount exceeds Soroban i128");

export const senderRuleSchema = z.enum(["default", "allow", "block"]);
export const postageStatusSchema = z.enum(["pending", "settled", "refunded"]);

export const mailboxPolicySchema = z.object({
  allowUnknown: z.boolean(),
  minimumPostage: stroopAmountSchema,
  requireVerified: z.boolean(),
});

export const postageSchema = z.object({
  amount: stroopAmountSchema,
  createdAt: z.string().datetime(),
  messageId: hash32Schema,
  paymentHash: hash32Schema,
  recipient: stellarAddressSchema,
  sender: stellarAddressSchema,
  status: postageStatusSchema,
});

export const receiptSchema = z.object({
  deliveredAt: z.string().datetime(),
  messageId: hash32Schema,
  readAt: z.string().datetime().nullable(),
  recipient: stellarAddressSchema,
  sender: stellarAddressSchema,
});

export type MailboxPolicy = z.infer<typeof mailboxPolicySchema>;
export type Postage = z.infer<typeof postageSchema>;
export type PostageStatus = z.infer<typeof postageStatusSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type SenderRule = z.infer<typeof senderRuleSchema>;

export const idempotencyRecordSchema = z.object({
  status: z.number(),
  body: z.unknown(),
  createdAt: z.string().datetime(),
});

export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;

export const messageDeliveryStateSchema = z.enum([
  "queued",
  "accepted",
  "anchored",
  "delivered",
  "read",
  "failed",
  "expired",
]);

export type MessageDeliveryState = z.infer<typeof messageDeliveryStateSchema>;

export const TERMINAL_DELIVERY_STATES: ReadonlySet<MessageDeliveryState> = new Set([
  "read",
  "failed",
  "expired",
]);

export const RETRYABLE_DELIVERY_STATES: ReadonlySet<MessageDeliveryState> = new Set([
  "queued",
  "accepted",
  "anchored",
]);

export const ALLOWED_DELIVERY_TRANSITIONS: Record<
  MessageDeliveryState,
  ReadonlySet<MessageDeliveryState>
> = {
  queued: new Set(["accepted", "failed", "expired"]),
  accepted: new Set(["anchored", "delivered", "failed", "expired"]),
  anchored: new Set(["delivered", "failed", "expired"]),
  delivered: new Set(["read", "failed", "expired"]),
  read: new Set([]),
  failed: new Set([]),
  expired: new Set([]),
};

export const messageDeliveryTransitionSchema = z.object({
  fromState: messageDeliveryStateSchema.nullable(),
  toState: messageDeliveryStateSchema,
  timestamp: z.string().datetime(),
  actor: z.string().min(1),
  reason: z.string().min(1),
  chainReference: z.string().nullable().optional(),
});

export type MessageDeliveryTransition = z.infer<typeof messageDeliveryTransitionSchema>;

export const messageDeliveryStatusRecordSchema = z.object({
  messageId: hash32Schema,
  state: messageDeliveryStateSchema,
  isTerminal: z.boolean(),
  isRetryable: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  actor: z.string(),
  reason: z.string(),
  chainReference: z.string().nullable().optional(),
  history: z.array(messageDeliveryTransitionSchema),
});

export type MessageDeliveryStatusRecord = z.infer<typeof messageDeliveryStatusRecordSchema>;

export const publicDeliveryStatusSchema = z.object({
  messageId: hash32Schema,
  state: messageDeliveryStateSchema,
  isTerminal: z.boolean(),
  isRetryable: z.boolean(),
  observedAt: z.string().datetime(),
  actor: z.string(),
  reason: z.string(),
  chainReference: z.string().nullable().optional(),
  history: z.array(messageDeliveryTransitionSchema),
});

export type PublicDeliveryStatus = z.infer<typeof publicDeliveryStatusSchema>;
