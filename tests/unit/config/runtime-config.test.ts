import { describe, expect, it } from "vitest";
import {
  formatConfigMatrix,
  getPublicConfig,
  getRedactedConfig,
  loadRuntimeConfig,
} from "../../../src/config";

describe("BETA-001 :: Beta Runtime Configuration Contract", () => {
  describe("Profile Loading & Defaults", () => {
    it("loads development profile with sensible local defaults", () => {
      const config = loadRuntimeConfig({ profile: "development" });

      expect(config.profile).toBe("development");
      expect(config.network.stellarNetwork).toBe("testnet");
      expect(config.network.horizonUrl).toBe("https://horizon-testnet.stellar.org");
      expect(config.network.sorobanRpcUrl).toBe("https://soroban-testnet.stellar.org");
      expect(config.storage.storageDriver).toBe("memory");
      expect(config.storage.kvNamespaceId).toBe("stealth-kv-dev");
      expect(config.session.cursorSecret).toBe("dev-cursor-secret-change-me");
      expect(config.relay.relayUrl).toBe("https://relay-testnet.stealth.mail");
      expect(config.contract.domainTag).toBe("Stealth_Mail_Protocol");
      expect(config.contract.protocolVersion).toBe("v1");
      expect(config.origin.appUrl).toBe("http://localhost:3000");
    });

    it("loads test profile", () => {
      const config = loadRuntimeConfig({ profile: "test" });
      expect(config.profile).toBe("test");
    });

    it("loads preview profile", () => {
      const config = loadRuntimeConfig({ profile: "preview" });
      expect(config.profile).toBe("preview");
      expect(config.storage.storageDriver).toBe("hybrid");
      expect(config.storage.kvNamespaceId).toBe("stealth-kv-beta-preview");
    });

    it("loads production profile with a valid configuration", () => {
      const validProdEnv = {
        STEALTH_ENV: "production",
        STEALTH_CURSOR_SECRET: "prod-secret-key-32-chars-long-valid",
        STEALTH_KV_NAMESPACE_ID: "stealth-kv-beta-prod-id",
        STEALTH_REGISTRY_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        STEALTH_POSTAGE_CONTRACT_ID: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        STEALTH_APP_URL: "https://app.stealth.mail",
        STEALTH_CORS_ALLOWED_ORIGINS: "https://app.stealth.mail",
      };

      const config = loadRuntimeConfig({ profile: "production", env: validProdEnv });

      expect(config.profile).toBe("production");
      expect(config.network.stellarNetwork).toBe("mainnet");
      expect(config.network.horizonUrl).toBe("https://horizon.stellar.org");
      expect(config.storage.kvNamespaceId).toBe("stealth-kv-beta-prod-id");
      expect(config.session.cursorSecret).toBe("prod-secret-key-32-chars-long-valid");
      expect(config.origin.appUrl).toBe("https://app.stealth.mail");
    });
  });

  describe("Production Failure Gates & Boundary Checks", () => {
    it("fails production startup when STEALTH_CURSOR_SECRET is missing or empty", () => {
      expect(() =>
        loadRuntimeConfig({
          profile: "production",
          env: {
            STEALTH_CURSOR_SECRET: "",
            STEALTH_KV_NAMESPACE_ID: "stealth-kv-beta-prod-id",
            STEALTH_APP_URL: "https://app.stealth.mail",
          },
        }),
      ).toThrow(/STEALTH_CURSOR_SECRET is required/);
    });

    it("fails production startup when STEALTH_CURSOR_SECRET is a placeholder", () => {
      expect(() =>
        loadRuntimeConfig({
          profile: "production",
          env: {
            STEALTH_CURSOR_SECRET: "dev-cursor-secret-change-me",
            STEALTH_KV_NAMESPACE_ID: "stealth-kv-beta-prod-id",
            STEALTH_APP_URL: "https://app.stealth.mail",
          },
        }),
      ).toThrow(/STEALTH_CURSOR_SECRET is required and must not be a default\/placeholder/);
    });

    it("fails production startup when STEALTH_KV_NAMESPACE_ID is a placeholder", () => {
      expect(() =>
        loadRuntimeConfig({
          profile: "production",
          env: {
            STEALTH_CURSOR_SECRET: "prod-secret-key-32-chars-long-valid",
            STEALTH_KV_NAMESPACE_ID: "placeholder-prod-id",
            STEALTH_APP_URL: "https://app.stealth.mail",
          },
        }),
      ).toThrow(/STEALTH_KV_NAMESPACE_ID must be configured and cannot be a placeholder/);
    });

    it("fails production startup when STEALTH_REGISTRY_CONTRACT_ID is a placeholder", () => {
      expect(() =>
        loadRuntimeConfig({
          profile: "production",
          env: {
            STEALTH_CURSOR_SECRET: "prod-secret-key-32-chars-long-valid",
            STEALTH_KV_NAMESPACE_ID: "stealth-kv-beta-prod-id",
            STEALTH_REGISTRY_CONTRACT_ID: "C_REGISTRY_PLACEHOLDER",
            STEALTH_APP_URL: "https://app.stealth.mail",
          },
        }),
      ).toThrow(/STEALTH_REGISTRY_CONTRACT_ID is required and cannot be a placeholder/);
    });

    it("fails production startup when STEALTH_APP_URL is localhost", () => {
      expect(() =>
        loadRuntimeConfig({
          profile: "production",
          env: {
            STEALTH_CURSOR_SECRET: "prod-secret-key-32-chars-long-valid",
            STEALTH_KV_NAMESPACE_ID: "stealth-kv-beta-prod-id",
            STEALTH_APP_URL: "http://localhost:3000",
          },
        }),
      ).toThrow(/STEALTH_APP_URL must be a valid public origin/);
    });

    it("fails production startup when CORS origins contain a wildcard", () => {
      expect(() =>
        loadRuntimeConfig({
          profile: "production",
          env: {
            STEALTH_CURSOR_SECRET: "prod-secret-key-32-chars-long-valid",
            STEALTH_KV_NAMESPACE_ID: "stealth-kv-beta-prod-id",
            STEALTH_APP_URL: "https://app.stealth.mail",
            STEALTH_CORS_ALLOWED_ORIGINS: "*",
          },
        }),
      ).toThrow(/STEALTH_CORS_ALLOWED_ORIGINS must contain explicit origin URLs/);
    });
  });

  describe("Public/Secret Separation & Redaction Safety", () => {
    it("getPublicConfig strips secret parameters completely", () => {
      const config = loadRuntimeConfig({
        profile: "development",
        env: {
          STEALTH_CURSOR_SECRET: "super-secret-key",
          STEALTH_RELAY_API_KEY: "secret-relay-token",
        },
      });

      const publicConfig = getPublicConfig(config);

      expect((publicConfig as any).session.cursorSecret).toBeUndefined();
      expect((publicConfig as any).relay.relayApiKey).toBeUndefined();
      expect(publicConfig.network.horizonUrl).toBe("https://horizon-testnet.stellar.org");
    });

    it("getRedactedConfig replaces secret values with [REDACTED]", () => {
      const config = loadRuntimeConfig({
        profile: "development",
        env: {
          STEALTH_CURSOR_SECRET: "super-secret-key",
          STEALTH_RELAY_API_KEY: "secret-relay-token",
        },
      });

      const redacted = getRedactedConfig(config) as any;

      expect(redacted.session.cursorSecret).toBe("[REDACTED]");
      expect(redacted.relay.relayApiKey).toBe("[REDACTED]");
      expect(redacted.relay.hasRelayApiKey).toBe(true);
    });

    it("never leaks actual secret values in error messages", () => {
      const sensitiveSecret = "my-ultra-secret-value-12345";
      let errorMessage = "";

      try {
        loadRuntimeConfig({
          profile: "production",
          env: {
            STEALTH_CURSOR_SECRET: sensitiveSecret,
            STEALTH_KV_NAMESPACE_ID: "placeholder-prod-id", // triggers failure
            STEALTH_APP_URL: "https://app.stealth.mail",
          },
        });
      } catch (err) {
        errorMessage = (err as Error).message;
      }

      expect(errorMessage).not.toContain(sensitiveSecret);
    });
  });

  describe("Config Matrix Formatting", () => {
    it("formatConfigMatrix outputs all 6 domain sections with redacted secrets", () => {
      const config = loadRuntimeConfig({
        profile: "development",
        env: {
          STEALTH_CURSOR_SECRET: "secret-123",
          STEALTH_RELAY_API_KEY: "api-key-456",
        },
      });

      const matrix = formatConfigMatrix(config);

      expect(matrix).toContain("=== Stealth Mail Beta Runtime Configuration Matrix ===");
      expect(matrix).toContain("[Network]");
      expect(matrix).toContain("[Storage]");
      expect(matrix).toContain("[Session & Security]");
      expect(matrix).toContain("[Relay]");
      expect(matrix).toContain("[Contract]");
      expect(matrix).toContain("[Origin & CORS]");
      expect(matrix).toContain("Cursor Secret:         [REDACTED]");
      expect(matrix).toContain("Relay API Key:         [REDACTED]");
      expect(matrix).not.toContain("secret-123");
      expect(matrix).not.toContain("api-key-456");
    });
  });
});
