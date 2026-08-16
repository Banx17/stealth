import { beforeEach, describe, expect, it } from "vitest";
import {
  authenticateWithPassword,
  buildClearSessionCookie,
  buildSessionCookie,
  logoutSession,
  parseSessionCookie,
  validateSession,
  MAX_LOGIN_ATTEMPTS,
} from "../../../../src/server/api/auth/session-service";
import { hashPassword } from "../../../../src/server/api/auth/password";
import { createApiContext } from "../../../../src/server/api/context";
import type { AccountStatus, Credential, User } from "../../../../src/server/api/domain";
import { ApiError } from "../../../../src/server/api/errors";
import { MemoryApiRepository } from "../../../../src/server/api/memory-repository";

describe("BETA-006: Password Login & Server-Side Sessions", () => {
  let repo: MemoryApiRepository;
  let apiContext: ReturnType<typeof createApiContext>;

  let addressIndex = 0;
  const defaultPassword = "SecurePassword!2026";

  async function seedTestUser(
    options: {
      userId?: string;
      email?: string;
      username?: string;
      password?: string;
      status?: AccountStatus;
    } = {},
  ) {
    addressIndex += 1;
    const char = String.fromCharCode(65 + (addressIndex % 26));
    const address = `G${char.repeat(55)}`;

    const userId = options.userId ?? `usr_test_${addressIndex}`;
    const email = options.email ?? `alice_${addressIndex}@stealth.mail`;
    const username = options.username ?? `alice_privacy_${addressIndex}`;
    const password = options.password ?? defaultPassword;
    const status = options.status ?? "active";

    const { hash, salt } = await hashPassword(password);
    const secretHash = `${hash}:${salt}`;

    const user: User = {
      userId,
      address,
      email,
      username,
      status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    const credential: Credential = {
      credentialId: `cred_${userId}`,
      userId,
      authMethod: "password_hash",
      secretHash,
      walletKeyRef: `vault_${userId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await repo.createUser(user, credential);
    return { user, credential, password };
  }

  beforeEach(() => {
    repo = new MemoryApiRepository();
    apiContext = createApiContext(repo);
  });

  describe("Cookie Helpers", () => {
    it("parses stealth_session cookie from Cookie header", () => {
      const header = "theme=dark; stealth_session=sess_123456789; locale=en";
      expect(parseSessionCookie(header)).toBe("sess_123456789");
    });

    it("returns null when stealth_session cookie is absent", () => {
      expect(parseSessionCookie("theme=dark; locale=en")).toBeNull();
      expect(parseSessionCookie(null)).toBeNull();
    });

    it("builds valid HttpOnly, SameSite, Secure session cookie", () => {
      const cookie = buildSessionCookie("sess_abc", 3600, true);
      expect(cookie).toContain("stealth_session=sess_abc");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Lax");
    });

    it("builds clear session cookie", () => {
      const clearCookie = buildClearSessionCookie(true);
      expect(clearCookie).toContain("stealth_session=");
      expect(clearCookie).toContain("Max-Age=0");
    });
  });

  describe("authenticateWithPassword", () => {
    it("logs in successfully using valid email and password", async () => {
      await seedTestUser({ email: "bob@stealth.mail", password: "MyPassword!1" });

      const result = await authenticateWithPassword(apiContext, {
        identifier: "bob@stealth.mail",
        password: "MyPassword!1",
        ip: "127.0.0.1",
        userAgent: "TestAgent/1.0",
      });

      expect(result.user.email).toBe("bob@stealth.mail");
      expect(result.session.sessionId).toMatch(/^sess_/);
      expect(result.session.userId).toBe(result.user.userId);
      expect(result.session.ipAddress).toBe("127.0.0.1");
      expect(result.cookieHeader).toContain(`stealth_session=${result.session.sessionId}`);
    });

    it("logs in successfully using valid username and password", async () => {
      await seedTestUser({ username: "charlie_stealth", password: "MyPassword!1" });

      const result = await authenticateWithPassword(apiContext, {
        identifier: "Charlie_Stealth", // test case-insensitivity
        password: "MyPassword!1",
      });

      expect(result.user.username).toBe("charlie_stealth");
      expect(result.session.sessionId).toBeDefined();
    });

    it("does not reveal whether an email exists on invalid password or missing user", async () => {
      await seedTestUser({ email: "exists@stealth.mail" });

      // Wrong password for existing user
      let errorExisting: ApiError | undefined;
      try {
        await authenticateWithPassword(apiContext, {
          identifier: "exists@stealth.mail",
          password: "WrongPassword!99",
        });
      } catch (err) {
        errorExisting = err as ApiError;
      }

      // Non-existent user
      let errorMissing: ApiError | undefined;
      try {
        await authenticateWithPassword(apiContext, {
          identifier: "nonexistent@stealth.mail",
          password: "WrongPassword!99",
        });
      } catch (err) {
        errorMissing = err as ApiError;
      }

      expect(errorExisting?.status).toBe(401);
      expect(errorExisting?.message).toBe("Invalid email/username or password");

      expect(errorMissing?.status).toBe(401);
      expect(errorMissing?.message).toBe("Invalid email/username or password");
    });

    it("enforces account status boundaries (pending_verification, suspended, deactivated)", async () => {
      await seedTestUser({
        userId: "usr_unverified",
        email: "unverified@stealth.mail",
        username: "unverified_usr",
        status: "pending_verification",
      });
      await seedTestUser({
        userId: "usr_suspended",
        email: "suspended@stealth.mail",
        username: "suspended_usr",
        status: "suspended",
      });
      await seedTestUser({
        userId: "usr_deactivated",
        email: "deactivated@stealth.mail",
        username: "deactivated_usr",
        status: "deactivated",
      });

      // Unverified account
      await expect(
        authenticateWithPassword(apiContext, {
          identifier: "unverified@stealth.mail",
          password: defaultPassword,
        }),
      ).rejects.toThrow("Account verification required");

      // Suspended account
      await expect(
        authenticateWithPassword(apiContext, {
          identifier: "suspended@stealth.mail",
          password: defaultPassword,
        }),
      ).rejects.toThrow("Account suspended");

      // Deactivated account
      await expect(
        authenticateWithPassword(apiContext, {
          identifier: "deactivated@stealth.mail",
          password: defaultPassword,
        }),
      ).rejects.toThrow("Account deactivated");
    });

    it("throttles login attempts after repeated failures", async () => {
      const identifier = "target@stealth.mail";
      await seedTestUser({ email: identifier });

      // Trigger MAX_LOGIN_ATTEMPTS failures
      for (let i = 0; i < MAX_LOGIN_ATTEMPTS; i++) {
        await expect(
          authenticateWithPassword(apiContext, {
            identifier,
            password: "WrongPassword!",
          }),
        ).rejects.toThrow("Invalid email/username or password");
      }

      // Next attempt (even with correct password) should be throttled
      let throttledError: ApiError | undefined;
      try {
        await authenticateWithPassword(apiContext, {
          identifier,
          password: defaultPassword,
        });
      } catch (err) {
        throttledError = err as ApiError;
      }

      expect(throttledError?.status).toBe(429);
      expect(throttledError?.message).toBe("Too many login attempts. Please try again later");
    });

    it("prevents session fixation and rotates session identifiers", async () => {
      const { user } = await seedTestUser();

      // Initial login
      const firstLogin = await authenticateWithPassword(apiContext, {
        identifier: user.email,
        password: defaultPassword,
      });

      const oldSessionId = firstLogin.session.sessionId;
      expect(await repo.getSession(oldSessionId)).not.toBeNull();

      // Re-authenticate passing current session ID
      const secondLogin = await authenticateWithPassword(apiContext, {
        identifier: user.email,
        password: defaultPassword,
        currentSessionId: oldSessionId,
      });

      const newSessionId = secondLogin.session.sessionId;
      expect(newSessionId).not.toBe(oldSessionId);

      // Old session must be revoked
      expect(await repo.getSession(oldSessionId)).toBeNull();
      // New session must exist
      expect(await repo.getSession(newSessionId)).not.toBeNull();
    });
  });

  describe("validateSession & logoutSession", () => {
    it("validates an active session and updates lastActiveAt", async () => {
      const { user } = await seedTestUser();
      const authResult = await authenticateWithPassword(apiContext, {
        identifier: user.email,
        password: defaultPassword,
      });

      const validated = await validateSession(apiContext, authResult.session.sessionId);
      expect(validated).not.toBeNull();
      expect(validated?.user.userId).toBe(user.userId);
      expect(validated?.session.lastActiveAt).toBeDefined();
    });

    it("rejects an expired session and deletes it", async () => {
      const { user } = await seedTestUser();
      const authResult = await authenticateWithPassword(apiContext, {
        identifier: user.email,
        password: defaultPassword,
      });

      // Manually set session expiry to the past
      const expiredSession = {
        ...authResult.session,
        expiresAt: new Date(Date.now() - 10000).toISOString(),
      };
      await repo.updateSession(expiredSession);

      const validated = await validateSession(apiContext, expiredSession.sessionId);
      expect(validated).toBeNull();
      expect(await repo.getSession(expiredSession.sessionId)).toBeNull();
    });

    it("revokes session on logout", async () => {
      const { user } = await seedTestUser();
      const authResult = await authenticateWithPassword(apiContext, {
        identifier: user.email,
        password: defaultPassword,
      });

      const logoutResult = await logoutSession(apiContext, authResult.session.sessionId);
      expect(logoutResult.cookieHeader).toContain("Max-Age=0");
      expect(await repo.getSession(authResult.session.sessionId)).toBeNull();
    });
  });
});
