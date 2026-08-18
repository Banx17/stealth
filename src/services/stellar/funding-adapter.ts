import { DEFAULT_TESTNET_FRIENDBOT_URL } from "./funding-config";

export interface FundAccountResult {
  funded: boolean;
  transactionId?: string;
}

export interface StellarFundingAdapter {
  fundAccount(publicKey: string): Promise<FundAccountResult>;
}

export class FriendbotFundingAdapter implements StellarFundingAdapter {
  constructor(private readonly friendbotUrl: string = DEFAULT_TESTNET_FRIENDBOT_URL) {}

  async fundAccount(publicKey: string): Promise<FundAccountResult> {
    const url = `${this.friendbotUrl}?addr=${encodeURIComponent(publicKey)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Friendbot funding failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { hash?: string };
    return {
      funded: true,
      transactionId: typeof payload.hash === "string" ? payload.hash : undefined,
    };
  }
}

/** Deterministic in-memory funding adapter for unit/integration tests. */
export class FakeFundingAdapter implements StellarFundingAdapter {
  readonly fundedAccounts = new Set<string>();
  readonly failures = new Set<string>();

  async fundAccount(publicKey: string): Promise<FundAccountResult> {
    if (this.failures.has(publicKey)) {
      throw new Error("Simulated funding failure");
    }
    this.fundedAccounts.add(publicKey);
    return { funded: true, transactionId: `fake-tx-${publicKey.slice(0, 8)}` };
  }
}

export function createFundingAdapter(
  options: {
    friendbotUrl?: string;
    useFake?: boolean;
  } = {},
): StellarFundingAdapter {
  if (options.useFake) {
    return new FakeFundingAdapter();
  }
  return new FriendbotFundingAdapter(options.friendbotUrl ?? DEFAULT_TESTNET_FRIENDBOT_URL);
}
