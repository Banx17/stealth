import type {
  ExternalWallet,
  ExternalWalletChallenge,
  IdempotencyRecord,
  MailboxPolicy,
  Postage,
  Receipt,
  SenderRule,
} from "./domain";
import type { ApiRepository } from "./repository";

function key(owner: string, sender: string) {
  return `${owner}:${sender}`;
}

export class MemoryApiRepository implements ApiRepository {
  private readonly policies = new Map<string, MailboxPolicy>();
  private readonly postage = new Map<string, Postage>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly senderRules = new Map<string, SenderRule>();
  private readonly counters = new Map<string, number[]>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly externalWallets = new Map<string, ExternalWallet[]>();
  private readonly walletChallenges = new Map<string, ExternalWalletChallenge>();

  async getPolicy(owner: string) {
    return structuredClone(this.policies.get(owner) ?? null);
  }

  async setPolicy(owner: string, policy: MailboxPolicy) {
    this.policies.set(owner, structuredClone(policy));
    return structuredClone(policy);
  }

  async getSenderRule(owner: string, sender: string) {
    return this.senderRules.get(key(owner, sender)) ?? "default";
  }

  async setSenderRule(owner: string, sender: string, rule: SenderRule) {
    const ruleKey = key(owner, sender);
    if (rule === "default") this.senderRules.delete(ruleKey);
    else this.senderRules.set(ruleKey, rule);
    return rule;
  }

  async getPostage(messageId: string) {
    return structuredClone(this.postage.get(messageId) ?? null);
  }

  async setPostage(postage: Postage) {
    this.postage.set(postage.messageId, structuredClone(postage));
    return structuredClone(postage);
  }

  async getReceipt(messageId: string) {
    return structuredClone(this.receipts.get(messageId) ?? null);
  }

  async setReceipt(receipt: Receipt) {
    this.receipts.set(receipt.messageId, structuredClone(receipt));
    return structuredClone(receipt);
  }

  async getRelayQueueDepth(_relayId: string) {
    return 0;
  }

  async getRelayRetryCount(_relayId: string) {
    return 0;
  }

  async getRelayLastSuccessfulDelivery(_relayId: string) {
    return null;
  }

  async getRelayLastFailedDelivery(_relayId: string) {
    return null;
  }

  async getRelayDeadLetterCount(_relayId: string) {
    return 0;
  }
  async getCounter(key: string) {
    return this.counters.get(key)?.length ?? 0;
  }

  async incrementCounter(key: string, windowSeconds: number) {
    const now = Date.now();
    const windowMilliseconds = windowSeconds * 1000;
    const timestamps = this.counters.get(key) ?? [];
    const filtered = [...timestamps, now].filter(
      (timestamp) => now - timestamp <= windowMilliseconds,
    );
    this.counters.set(key, filtered);
    return filtered.length;
  }

  async getIdempotencyRecord(key: string) {
    return structuredClone(this.idempotency.get(key) ?? null);
  }

  async setIdempotencyRecord(key: string, record: IdempotencyRecord) {
    this.idempotency.set(key, structuredClone(record));
  }

  async getExternalWallets(owner: string): Promise<ExternalWallet[]> {
    return structuredClone(this.externalWallets.get(owner) ?? []);
  }

  async setExternalWallet(owner: string, wallet: ExternalWallet): Promise<ExternalWallet> {
    const wallets = this.externalWallets.get(owner) ?? [];
    const existing = wallets.findIndex((w) => w.address === wallet.address);
    if (existing >= 0) {
      wallets[existing] = structuredClone(wallet);
    } else {
      wallets.push(structuredClone(wallet));
    }
    this.externalWallets.set(owner, wallets);
    return structuredClone(wallet);
  }

  async removeExternalWallet(owner: string, address: string): Promise<void> {
    const wallets = this.externalWallets.get(owner) ?? [];
    this.externalWallets.set(
      owner,
      wallets.filter((w) => w.address !== address),
    );
  }

  async findExternalWalletOwner(address: string): Promise<string | null> {
    for (const [owner, wallets] of this.externalWallets.entries()) {
      if (wallets.some((w) => w.address === address)) {
        return owner;
      }
    }
    return null;
  }

  walletChallengeKey(owner: string, address: string) {
    return `${owner}:${address}`;
  }

  async getWalletChallenge(
    owner: string,
    address: string,
  ): Promise<ExternalWalletChallenge | null> {
    return structuredClone(
      this.walletChallenges.get(this.walletChallengeKey(owner, address)) ?? null,
    );
  }

  async setWalletChallenge(
    owner: string,
    address: string,
    challenge: ExternalWalletChallenge,
  ): Promise<void> {
    this.walletChallenges.set(this.walletChallengeKey(owner, address), structuredClone(challenge));
  }

  async deleteWalletChallenge(owner: string, address: string): Promise<void> {
    this.walletChallenges.delete(this.walletChallengeKey(owner, address));
  }

  reset() {
    this.policies.clear();
    this.postage.clear();
    this.receipts.clear();
    this.senderRules.clear();
    this.counters.clear();
    this.idempotency.clear();
    this.externalWallets.clear();
    this.walletChallenges.clear();
  }
}
