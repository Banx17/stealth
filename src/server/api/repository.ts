import type {
  ExternalWallet,
  ExternalWalletChallenge,
  IdempotencyRecord,
  MailboxPolicy,
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
  getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null>;
  setIdempotencyRecord(key: string, record: IdempotencyRecord): Promise<void>;

  getExternalWallets(owner: string): Promise<ExternalWallet[]>;
  setExternalWallet(owner: string, wallet: ExternalWallet): Promise<ExternalWallet>;
  removeExternalWallet(owner: string, address: string): Promise<void>;
  findExternalWalletOwner(address: string): Promise<string | null>;
  getWalletChallenge(owner: string, address: string): Promise<ExternalWalletChallenge | null>;
  setWalletChallenge(
    owner: string,
    address: string,
    challenge: ExternalWalletChallenge,
  ): Promise<void>;
  deleteWalletChallenge(owner: string, address: string): Promise<void>;

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
