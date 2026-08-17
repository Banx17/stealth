import type {
  IdempotencyRecord,
  MailboxPolicy,
  MessageDeliveryStatusRecord,
  Postage,
  Receipt,
  SenderRule,
} from "./domain";

export interface ApiRepository {
  getPolicy(owner: string): Promise<MailboxPolicy | null>;
  setPolicy(owner: string, policy: MailboxPolicy): Promise<MailboxPolicy>;
  getSenderRule(owner: string, sender: string): Promise<SenderRule>;
  setSenderRule(owner: string, sender: string, rule: SenderRule): Promise<SenderRule>;
  getPostage(messageId: string): Promise<Postage | null>;
  setPostage(postage: Postage): Promise<Postage>;
  getReceipt(messageId: string): Promise<Receipt | null>;
  setReceipt(receipt: Receipt): Promise<Receipt>;
  getMessageDeliveryStatus(messageId: string): Promise<MessageDeliveryStatusRecord | null>;
  setMessageDeliveryStatus(
    record: MessageDeliveryStatusRecord,
  ): Promise<MessageDeliveryStatusRecord>;
  getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null>;
  setIdempotencyRecord(key: string, record: IdempotencyRecord): Promise<void>;

  getRelayQueueDepth(relayId: string): Promise<number>;
  getRelayRetryCount(relayId: string): Promise<number>;
  getRelayLastSuccessfulDelivery(relayId: string): Promise<string | null>;
  getRelayLastFailedDelivery(relayId: string): Promise<string | null>;
  getRelayDeadLetterCount(relayId: string): Promise<number>;
  getCounter(key: string): Promise<number>;
  incrementCounter(key: string, windowSeconds: number): Promise<number>;
}

export const defaultMailboxPolicy: MailboxPolicy = {
  allowUnknown: false,
  minimumPostage: "0",
  requireVerified: true,
};
