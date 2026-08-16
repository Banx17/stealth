import {
  runtimeConfigSchema,
  type BetaRuntimeConfig,
  type ConfigProfile,
  type PublicConfig,
} from "./schema";

const DEFAULT_ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"];

const DEFAULT_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "x-stealth-address",
  "x-stealth-delegation",
  "x-request-id",
  "traceparent",
  "tracestate",
  "baggage",
];

export interface LoadConfigOptions {
  profile?: ConfigProfile;
  env?: Record<string, unknown>;
}

function parseList(value: unknown, defaultList: string[]): string[] {
  if (typeof value === "string") {
    const split = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (split.length > 0) return split;
  }
  if (Array.isArray(value)) {
    const filtered = value
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
    if (filtered.length > 0) return filtered;
  }
  return [...defaultList];
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && !isNaN(value)) return value;
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return fallback;
}

function isPlaceholderSecret(secret: string | undefined): boolean {
  if (!secret) return true;
  const lower = secret.toLowerCase().trim();
  return (
    lower === "" ||
    lower === "dev-secret" ||
    lower === "dev-cursor-secret-change-me" ||
    lower === "placeholder" ||
    lower === "change-me"
  );
}

function isPlaceholderKvId(id: string | undefined): boolean {
  if (!id) return true;
  const lower = id.toLowerCase().trim();
  return (
    lower === "" ||
    lower === "placeholder-prod-id" ||
    lower === "placeholder-preview-id" ||
    lower === "placeholder"
  );
}

function isPlaceholderContractId(id: string | undefined): boolean {
  if (!id) return true;
  return id.includes("PLACEHOLDER") || id === "placeholder";
}

/**
 * Load and validate the complete Beta Runtime Configuration contract.
 */
export function loadRuntimeConfig(options: LoadConfigOptions = {}): BetaRuntimeConfig {
  const env: Record<string, unknown> = {
    ...(typeof process !== "undefined" ? process.env : {}),
    ...(options.env ?? {}),
  };

  // Determine profile
  const profileRaw =
    options.profile ??
    (env.STEALTH_ENV as string) ??
    (env.NODE_ENV as string) ??
    (env.MODE as string) ??
    "development";

  let profile: ConfigProfile = "development";
  if (profileRaw === "production" || profileRaw === "prod") profile = "production";
  else if (profileRaw === "preview" || profileRaw === "staging") profile = "preview";
  else if (profileRaw === "test") profile = "test";
  else profile = "development";

  const isProd = profile === "production";
  const isPreview = profile === "preview";

  // 1. Network
  const stellarNetwork = (env.STEALTH_STELLAR_NETWORK as any) ?? (isProd ? "mainnet" : "testnet");
  const horizonUrl =
    (env.STEALTH_HORIZON_URL as string) ??
    (stellarNetwork === "mainnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");
  const sorobanRpcUrl =
    (env.STEALTH_SOROBAN_RPC_URL as string) ??
    (stellarNetwork === "mainnet"
      ? "https://soroban-rpc.mainnet.stellar.org"
      : "https://soroban-testnet.stellar.org");
  const networkPassphrase =
    (env.STEALTH_NETWORK_PASSPHRASE as string) ??
    (stellarNetwork === "mainnet"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015");

  // 2. Storage
  const storageDriver =
    (env.STEALTH_STORAGE_DRIVER as any) ?? (isProd || isPreview ? "hybrid" : "memory");
  const kvNamespaceId =
    (env.STEALTH_KV_NAMESPACE_ID as string) ??
    (isProd ? "stealth-kv-beta-prod" : isPreview ? "stealth-kv-beta-preview" : "stealth-kv-dev");
  const kvBinding = options.env?.STEALTH_KV ?? env.STEALTH_KV;
  const coordinatorBinding = options.env?.STEALTH_COORDINATOR ?? env.STEALTH_COORDINATOR;

  // 3. Session & Security
  const cursorSecret =
    (env.STEALTH_CURSOR_SECRET as string) ?? (isProd ? "" : "dev-cursor-secret-change-me");
  const authChallengeLifetimeMs = parseNumber(env.STEALTH_AUTH_CHALLENGE_LIFETIME_MS, 300000);
  const authClockSkewMs = parseNumber(env.STEALTH_AUTH_CLOCK_SKEW_MS, 30000);
  const authNonceTtlMs = parseNumber(env.STEALTH_AUTH_NONCE_TTL_MS, 300000);
  const quoteLifetimeMs = parseNumber(env.STEALTH_QUOTE_LIFETIME_MS, 300000);

  // 4. Relay
  const relayUrl =
    (env.STEALTH_RELAY_URL as string) ??
    (isProd ? "https://relay.stealth.mail" : "https://relay-testnet.stealth.mail");
  const relayApiKey = (env.STEALTH_RELAY_API_KEY as string) || undefined;
  const relayTimeoutMs = parseNumber(env.STEALTH_RELAY_TIMEOUT_MS, 10000);

  // 5. Contract
  const registryContractId =
    (env.STEALTH_REGISTRY_CONTRACT_ID as string) ??
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const postageContractId =
    (env.STEALTH_POSTAGE_CONTRACT_ID as string) ??
    "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const domainTag = (env.STEALTH_DOMAIN_TAG as string) ?? "Stealth_Mail_Protocol";
  const protocolVersion = (env.STEALTH_PROTOCOL_VERSION as string) ?? "v1";

  // 6. Origin
  const appUrl =
    (env.STEALTH_APP_URL as string) ??
    (isProd ? "https://app.stealth.mail" : "http://localhost:3000");
  const allowedOrigins = parseList(
    env.STEALTH_CORS_ALLOWED_ORIGINS,
    isProd ? ["https://app.stealth.mail"] : ["http://localhost:3000", "http://localhost:5173"],
  );
  const allowedMethods = parseList(env.STEALTH_CORS_ALLOWED_METHODS, DEFAULT_ALLOWED_METHODS);
  const allowedHeaders = parseList(env.STEALTH_CORS_ALLOWED_HEADERS, DEFAULT_ALLOWED_HEADERS);
  const allowCredentials =
    typeof env.STEALTH_CORS_ALLOW_CREDENTIALS === "boolean"
      ? env.STEALTH_CORS_ALLOW_CREDENTIALS
      : typeof env.STEALTH_CORS_ALLOW_CREDENTIALS === "string"
        ? env.STEALTH_CORS_ALLOW_CREDENTIALS.toLowerCase() === "true"
        : true;

  // Perform validation gates according to profile
  if (isProd) {
    if (isPlaceholderSecret(cursorSecret)) {
      throw new Error(
        "Configuration error: STEALTH_CURSOR_SECRET is required and must not be a default/placeholder secret in production.",
      );
    }
    if (isPlaceholderKvId(kvNamespaceId)) {
      throw new Error(
        "Configuration error: STEALTH_KV_NAMESPACE_ID must be configured and cannot be a placeholder in production.",
      );
    }
    if (isPlaceholderContractId(registryContractId) || !registryContractId) {
      throw new Error(
        "Configuration error: STEALTH_REGISTRY_CONTRACT_ID is required and cannot be a placeholder in production.",
      );
    }
    if (isPlaceholderContractId(postageContractId) || !postageContractId) {
      throw new Error(
        "Configuration error: STEALTH_POSTAGE_CONTRACT_ID is required and cannot be a placeholder in production.",
      );
    }
    if (!appUrl || appUrl.includes("localhost")) {
      throw new Error(
        "Configuration error: STEALTH_APP_URL must be a valid public origin in production.",
      );
    }
    if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
      throw new Error(
        "Configuration error: STEALTH_CORS_ALLOWED_ORIGINS must contain explicit origin URLs in production.",
      );
    }
  }

  const rawConfig = {
    profile,
    network: {
      network: profile,
      stellarNetwork,
      horizonUrl,
      sorobanRpcUrl,
      networkPassphrase,
    },
    storage: {
      storageDriver,
      kvNamespaceId,
      kvBinding,
      coordinatorBinding,
    },
    session: {
      cursorSecret,
      authChallengeLifetimeMs,
      authClockSkewMs,
      authNonceTtlMs,
      quoteLifetimeMs,
    },
    relay: {
      relayUrl,
      relayApiKey,
      relayTimeoutMs,
    },
    contract: {
      registryContractId,
      postageContractId,
      domainTag,
      protocolVersion,
    },
    origin: {
      appUrl,
      allowedOrigins,
      allowedMethods,
      allowedHeaders,
      allowCredentials,
    },
  };

  const parsed = runtimeConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const formattedErrors = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Configuration validation failed: ${formattedErrors}`);
  }

  return parsed.data;
}

/**
 * Extracts a client-safe public configuration object with ZERO secrets.
 */
export function getPublicConfig(config: BetaRuntimeConfig): PublicConfig {
  return {
    profile: config.profile,
    network: config.network,
    storage: {
      storageDriver: config.storage.storageDriver,
      kvNamespaceId: config.storage.kvNamespaceId,
    },
    session: {
      authChallengeLifetimeMs: config.session.authChallengeLifetimeMs,
      authClockSkewMs: config.session.authClockSkewMs,
      authNonceTtlMs: config.session.authNonceTtlMs,
      quoteLifetimeMs: config.session.quoteLifetimeMs,
    },
    relay: {
      relayUrl: config.relay.relayUrl,
      relayTimeoutMs: config.relay.relayTimeoutMs,
    },
    contract: config.contract,
    origin: config.origin,
  };
}

/**
 * Returns a redacted copy of the configuration safe for server logs and diagnostics.
 */
export function getRedactedConfig(config: BetaRuntimeConfig): Record<string, unknown> {
  return {
    profile: config.profile,
    network: config.network,
    storage: {
      storageDriver: config.storage.storageDriver,
      kvNamespaceId: config.storage.kvNamespaceId,
      hasKvBinding: Boolean(config.storage.kvBinding),
      hasCoordinatorBinding: Boolean(config.storage.coordinatorBinding),
    },
    session: {
      cursorSecret: "[REDACTED]",
      authChallengeLifetimeMs: config.session.authChallengeLifetimeMs,
      authClockSkewMs: config.session.authClockSkewMs,
      authNonceTtlMs: config.session.authNonceTtlMs,
      quoteLifetimeMs: config.session.quoteLifetimeMs,
    },
    relay: {
      relayUrl: config.relay.relayUrl,
      hasRelayApiKey: Boolean(config.relay.relayApiKey),
      relayApiKey: config.relay.relayApiKey ? "[REDACTED]" : undefined,
      relayTimeoutMs: config.relay.relayTimeoutMs,
    },
    contract: config.contract,
    origin: config.origin,
  };
}

/**
 * Formats a human-readable redacted configuration matrix for operational logs.
 */
export function formatConfigMatrix(config: BetaRuntimeConfig): string {
  const redacted = getRedactedConfig(config) as any;
  const lines: string[] = [
    `=== Stealth Mail Beta Runtime Configuration Matrix ===`,
    `Profile:                 ${config.profile}`,
    `[Network]`,
    `  Stellar Network:       ${config.network.stellarNetwork}`,
    `  Horizon RPC:           ${config.network.horizonUrl}`,
    `  Soroban RPC:           ${config.network.sorobanRpcUrl}`,
    `  Network Passphrase:    ${config.network.networkPassphrase}`,
    `[Storage]`,
    `  Storage Driver:        ${config.storage.storageDriver}`,
    `  KV Namespace ID:       ${config.storage.kvNamespaceId}`,
    `  Cloudflare KV:         ${redacted.storage.hasKvBinding ? "Bound" : "Unbound"}`,
    `  Durable Coordinator:   ${redacted.storage.hasCoordinatorBinding ? "Bound" : "Unbound"}`,
    `[Session & Security]`,
    `  Cursor Secret:         [REDACTED]`,
    `  Challenge TTL:         ${config.session.authChallengeLifetimeMs} ms`,
    `  Clock Skew:            ${config.session.authClockSkewMs} ms`,
    `  Nonce TTL:             ${config.session.authNonceTtlMs} ms`,
    `  Quote Lifetime:        ${config.session.quoteLifetimeMs} ms`,
    `[Relay]`,
    `  Relay URL:             ${config.relay.relayUrl}`,
    `  Relay API Key:         ${redacted.relay.hasRelayApiKey ? "[REDACTED]" : "None"}`,
    `  Relay Timeout:         ${config.relay.relayTimeoutMs} ms`,
    `[Contract]`,
    `  Registry Contract:     ${config.contract.registryContractId}`,
    `  Postage Contract:      ${config.contract.postageContractId}`,
    `  Domain Tag:            ${config.contract.domainTag}`,
    `  Protocol Version:      ${config.contract.protocolVersion}`,
    `[Origin & CORS]`,
    `  App URL:               ${config.origin.appUrl}`,
    `  Allowed Origins:       ${config.origin.allowedOrigins.join(", ")}`,
    `  Allowed Methods:       ${config.origin.allowedMethods.join(", ")}`,
    `======================================================`,
  ];
  return lines.join("\n");
}
