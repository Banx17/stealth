import { z } from "zod";

export const stellarAddressSchema = z
  .string()
  .trim()
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

export const walletCapabilitySchema = z.enum(["sign", "send", "read"]);
export type WalletCapability = z.infer<typeof walletCapabilitySchema>;

export const externalWalletSchema = z.object({
  address: stellarAddressSchema,
  capabilities: z.array(walletCapabilitySchema).min(1),
  linkedAt: z.string().datetime(),
  network: z.string().min(1),
});

export type ExternalWallet = z.infer<typeof externalWalletSchema>;

export const externalWalletChallengeSchema = z.object({
  challenge: z.string().min(1),
  address: stellarAddressSchema,
  expiresAt: z.string().datetime(),
  network: z.string().min(1),
});

export type ExternalWalletChallenge = z.infer<typeof externalWalletChallengeSchema>;

export const networkPassphraseSchema = z.string().min(1);
