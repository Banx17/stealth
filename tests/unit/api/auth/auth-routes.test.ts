import { beforeEach, describe, expect, it } from "vitest";
import { Route as LoginRoute } from "../../../../src/routes/api/v1/auth/login";
import { Route as LogoutRoute } from "../../../../src/routes/api/v1/auth/logout";
import { Route as SessionRoute } from "../../../../src/routes/api/v1/auth/session";
import { hashPassword } from "../../../../src/server/api/auth/password";
import type { Credential, User } from "../../../../src/server/api/domain";
import { MemoryApiRepository } from "../../../../src/server/api/memory-repository";

describe("BETA-006: Auth API Routes (/api/v1/auth/*)", () => {
  let repo: MemoryApiRepository;
  const validStellarAddress = `G${"A".repeat(55)}`;
  const testPassword = "Password123!";

  beforeEach(async () => {
    repo = new MemoryApiRepository();
    (globalThis as any).__stealthApiRepository = repo;

    // Seed test user
    const { hash, salt } = await hashPassword(testPassword);
    const user: User = {
      userId: "usr_route_test",
      address: validStellarAddress,
      email: "route_user@stealth.mail",
      username: "route_user",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    const credential: Credential = {
      credentialId: "cred_route_test",
      userId: "usr_route_test",
      authMethod: "password_hash",
      secretHash: `${hash}:${salt}`,
      walletKeyRef: "vault_ref",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await repo.createUser(user, credential);
  });

  it("POST /api/v1/auth/login succeeds with valid credentials and sets Set-Cookie header", async () => {
    const handler = (LoginRoute.options.server?.handlers as any).POST;
    const request = new Request("https://stealth.mail/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "route_user@stealth.mail",
        password: testPassword,
      }),
    });

    const response = await handler({ request });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.data.user.email).toBe("route_user@stealth.mail");
    expect(data.data.session.sessionId).toBeDefined();

    const setCookie = response.headers.get("Set-Cookie");
    expect(setCookie).toContain("stealth_session=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("POST /api/v1/auth/login fails with 401 on invalid password", async () => {
    const handler = (LoginRoute.options.server?.handlers as any).POST;
    const request = new Request("https://stealth.mail/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "route_user@stealth.mail",
        password: "WrongPassword!00",
      }),
    });

    const response = await handler({ request });
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error.message).toBe("Invalid email/username or password");
  });

  it("GET /api/v1/auth/session returns user and session when cookie is valid", async () => {
    // Perform login first to acquire cookie
    const loginHandler = (LoginRoute.options.server?.handlers as any).POST;
    const loginRequest = new Request("https://stealth.mail/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "route_user",
        password: testPassword,
      }),
    });
    const loginResponse = await loginHandler({ request: loginRequest });
    const cookieHeader = loginResponse.headers.get("Set-Cookie");

    // Extract cookie
    const cookieVal = cookieHeader?.split(";")[0];

    // Call session endpoint
    const sessionHandler = (SessionRoute.options.server?.handlers as any).GET;
    const sessionRequest = new Request("https://stealth.mail/api/v1/auth/session", {
      method: "GET",
      headers: { Cookie: cookieVal! },
    });

    const response = await sessionHandler({ request: sessionRequest });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.data.user.username).toBe("route_user");
    expect(data.data.session.sessionId).toBeDefined();
  });

  it("POST /api/v1/auth/logout revokes session and clears cookie", async () => {
    // Login first
    const loginHandler = (LoginRoute.options.server?.handlers as any).POST;
    const loginRequest = new Request("https://stealth.mail/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "route_user",
        password: testPassword,
      }),
    });
    const loginResponse = await loginHandler({ request: loginRequest });
    const cookieHeader = loginResponse.headers.get("Set-Cookie");
    const cookieVal = cookieHeader?.split(";")[0];

    // Logout
    const logoutHandler = (LogoutRoute.options.server?.handlers as any).POST;
    const logoutRequest = new Request("https://stealth.mail/api/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: cookieVal! },
    });

    const logoutResponse = await logoutHandler({ request: logoutRequest });
    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.headers.get("Set-Cookie")).toContain("Max-Age=0");

    // Session endpoint should now return 401
    const sessionHandler = (SessionRoute.options.server?.handlers as any).GET;
    const sessionRequest = new Request("https://stealth.mail/api/v1/auth/session", {
      method: "GET",
      headers: { Cookie: cookieVal! },
    });
    const sessionResponse = await sessionHandler({ request: sessionRequest });
    expect(sessionResponse.status).toBe(401);
  });

  it("POST /api/v1/auth/session renews session and rotates session ID", async () => {
    // Login first
    const loginHandler = (LoginRoute.options.server?.handlers as any).POST;
    const loginRequest = new Request("https://stealth.mail/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "route_user",
        password: testPassword,
      }),
    });
    const loginResponse = await loginHandler({ request: loginRequest });
    const oldCookieHeader = loginResponse.headers.get("Set-Cookie");
    const oldCookieVal = oldCookieHeader?.split(";")[0];

    // Renew session
    const renewHandler = (SessionRoute.options.server?.handlers as any).POST;
    const renewRequest = new Request("https://stealth.mail/api/v1/auth/session", {
      method: "POST",
      headers: { Cookie: oldCookieVal! },
    });

    const renewResponse = await renewHandler({ request: renewRequest });
    expect(renewResponse.status).toBe(200);

    const renewData = await renewResponse.json();
    expect(renewData.data.session.sessionId).toBeDefined();

    const newCookieHeader = renewResponse.headers.get("Set-Cookie");
    expect(newCookieHeader).toContain("stealth_session=");
    const newCookieVal = newCookieHeader?.split(";")[0];
    expect(newCookieVal).not.toBe(oldCookieVal);

    // Bootstrap GET with new session cookie should succeed
    const getHandler = (SessionRoute.options.server?.handlers as any).GET;
    const getRequest = new Request("https://stealth.mail/api/v1/auth/session", {
      method: "GET",
      headers: { Cookie: newCookieVal! },
    });
    const getResponse = await getHandler({ request: getRequest });
    expect(getResponse.status).toBe(200);
  });
});
