import type { ExternalWallet, WalletCapability } from "@/server/api/domain";

export class WalletLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletLinkError";
  }
}

export async function requestChallenge(
  externalAddress: string,
  network: string,
): Promise<{ challenge: string; expiresAt: string }> {
  const response = await fetch("/api/v1/wallet/link/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: externalAddress, network }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new WalletLinkError(body.error?.message ?? "Failed to create challenge");
  }
  return body.data;
}

export async function verifyAndLink(
  externalAddress: string,
  signature: string,
  capabilities: WalletCapability[],
  network: string,
): Promise<ExternalWallet> {
  const response = await fetch("/api/v1/wallet/link/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: externalAddress, signature, capabilities, network }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new WalletLinkError(body.error?.message ?? "Failed to verify and link wallet");
  }
  return body.data;
}

export async function listLinkedWallets(): Promise<ExternalWallet[]> {
  const response = await fetch("/api/v1/wallet/link");
  const body = await response.json();
  if (!response.ok) {
    throw new WalletLinkError(body.error?.message ?? "Failed to list linked wallets");
  }
  return body.data.wallets;
}

export async function unlinkWallet(address: string): Promise<void> {
  const response = await fetch(`/api/v1/wallet/link/${encodeURIComponent(address)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const body = await response.json();
    throw new WalletLinkError(body.error?.message ?? "Failed to unlink wallet");
  }
}
