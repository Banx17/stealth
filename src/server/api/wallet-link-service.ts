import type { ExternalWallet, ExternalWalletChallenge, WalletCapability } from "./domain";
import { ApiError } from "./errors";
import type { ApiRepository } from "./repository";

const CHALLENGE_EXPIRY_MS = 5 * 60 * 1000;

function generateChallenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createChallenge(
  repository: ApiRepository,
  owner: string,
  externalAddress: string,
  network: string,
): Promise<ExternalWalletChallenge> {
  const existing = await repository.getWalletChallenge(owner, externalAddress);
  if (existing && new Date(existing.expiresAt).getTime() > Date.now()) {
    return existing;
  }

  const challenge: ExternalWalletChallenge = {
    challenge: generateChallenge(),
    address: externalAddress,
    expiresAt: new Date(Date.now() + CHALLENGE_EXPIRY_MS).toISOString(),
    network,
  };

  await repository.setWalletChallenge(owner, externalAddress, challenge);
  return challenge;
}

export async function verifyChallenge(
  repository: ApiRepository,
  owner: string,
  externalAddress: string,
  signature: string,
  signerAddress: string,
  network: string,
): Promise<{ verified: boolean; reason?: string }> {
  const stored = await repository.getWalletChallenge(owner, externalAddress);
  if (!stored) {
    return { verified: false, reason: "no_challenge_found" };
  }

  if (new Date(stored.expiresAt).getTime() <= Date.now()) {
    await repository.deleteWalletChallenge(owner, externalAddress);
    return { verified: false, reason: "challenge_expired" };
  }

  if (stored.address !== externalAddress) {
    return { verified: false, reason: "address_mismatch" };
  }

  if (stored.network !== network) {
    return { verified: false, reason: "network_mismatch" };
  }

  if (signerAddress !== externalAddress) {
    return { verified: false, reason: "signer_mismatch" };
  }

  if (!signature || signature.length === 0) {
    return { verified: false, reason: "invalid_signature" };
  }

  await repository.deleteWalletChallenge(owner, externalAddress);
  return { verified: true };
}

export async function linkExternalWallet(
  repository: ApiRepository,
  owner: string,
  wallet: ExternalWallet,
): Promise<ExternalWallet> {
  const existing = await repository.getExternalWallets(owner);
  const duplicate = existing.find((w) => w.address === wallet.address);
  if (duplicate) {
    throw new ApiError(409, "conflict", "This external wallet is already linked");
  }

  const ownerWithAddress = await repository.findExternalWalletOwner(wallet.address);
  if (ownerWithAddress && ownerWithAddress !== owner) {
    throw new ApiError(403, "forbidden", "This wallet is linked to another account");
  }

  return repository.setExternalWallet(owner, wallet);
}

export async function unlinkExternalWallet(
  repository: ApiRepository,
  owner: string,
  address: string,
): Promise<void> {
  const wallets = await repository.getExternalWallets(owner);
  const exists = wallets.some((w) => w.address === address);
  if (!exists) {
    throw new ApiError(404, "not_found", "External wallet not found");
  }
  await repository.removeExternalWallet(owner, address);
}

export async function listExternalWallets(
  repository: ApiRepository,
  owner: string,
): Promise<ExternalWallet[]> {
  return repository.getExternalWallets(owner);
}
