import type { ApiContext } from "../context";
import type { Session, User } from "../domain";
import { ApiError } from "../errors";
import { dummyVerifyPassword, verifyPassword } from "./password";

export const SESSION_COOKIE_NAME = "stealth_session";
export const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const MAX_LOGIN_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_SECONDS = 900; // 15 minutes

export interface AuthenticateInput {
  identifier: string;
  password: string;
  ip?: string;
  userAgent?: string;
  deviceFingerprint?: string;
  currentSessionId?: string;
}

export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    if (key === SESSION_COOKIE_NAME) {
      return value || null;
    }
  }
  return null;
}

export function buildSessionCookie(
  sessionId: string,
  maxAgeSeconds = DEFAULT_SESSION_TTL_SECONDS,
  isProd = false,
): string {
  const expires = new Date(Date.now() + maxAgeSeconds * 1000).toUTCString();
  const secureFlag = isProd ? "Secure; " : "";
  return `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; ${secureFlag}SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}; Expires=${expires}`;
}

export function buildClearSessionCookie(isProd = false): string {
  const secureFlag = isProd ? "Secure; " : "";
  return `${SESSION_COOKIE_NAME}=; HttpOnly; ${secureFlag}SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/**
 * Validates credentials with constant-time failure behavior, checks account status,
 * rotates session identifiers, and records session metadata.
 */
export async function authenticateWithPassword(
  apiContext: ApiContext,
  input: AuthenticateInput,
): Promise<{ user: User; session: Session; cookieHeader: string }> {
  const repo = apiContext.repository;
  const normalizedId = input.identifier.trim().toLowerCase();

  if (!normalizedId || !input.password) {
    throw new ApiError(400, "bad_request", "Identifier and password are required");
  }

  // Enforce throttling on repeated login failures
  const rateLimitKey = `login:fail:${normalizedId}`;
  const failCount = await repo.getCounter(rateLimitKey);
  if (failCount >= MAX_LOGIN_ATTEMPTS) {
    throw new ApiError(429, "too_many_requests", "Too many login attempts. Please try again later");
  }

  // Lookup user by email or username
  let user = await repo.getUserByEmail(normalizedId);
  if (!user) {
    user = await repo.getUserByUsername(normalizedId);
  }

  const credential = user ? await repo.getCredential(user.userId) : null;

  let isValidPassword = false;
  if (user && credential && credential.authMethod === "password_hash") {
    const parts = credential.secretHash.split(/[:$]/);
    if (parts.length >= 2) {
      const storedHash = parts[0];
      const saltHex = parts[1];
      isValidPassword = await verifyPassword(input.password, storedHash, saltHex);
    } else {
      await dummyVerifyPassword(input.password);
    }
  } else {
    // Constant-time execution path when user or credential is missing
    await dummyVerifyPassword(input.password);
  }

  if (!user || !credential || !isValidPassword) {
    await repo.incrementCounter(rateLimitKey, RATE_LIMIT_WINDOW_SECONDS, 1);
    throw new ApiError(401, "unauthorized", "Invalid email/username or password");
  }

  // Account status checks
  if (user.status === "pending_verification") {
    throw new ApiError(403, "forbidden", "Account verification required");
  }
  if (user.status === "suspended") {
    throw new ApiError(403, "forbidden", "Account suspended");
  }
  if (user.status === "deactivated") {
    throw new ApiError(403, "forbidden", "Account deactivated");
  }
  if (user.status !== "active") {
    throw new ApiError(403, "forbidden", "Account is not active");
  }

  // Session fixation prevention: rotate session if a previous session exists
  if (input.currentSessionId) {
    await repo.deleteSession(input.currentSessionId);
  }

  // Issue opaque server-side session
  const newSessionId = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEFAULT_SESSION_TTL_SECONDS * 1000);

  const session: Session = {
    sessionId: newSessionId,
    userId: user.userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    lastActiveAt: now.toISOString(),
    ipAddress: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    deviceFingerprint: input.deviceFingerprint ?? null,
  };

  await repo.createSession(session);

  const isProd = import.meta.env?.PROD ?? false;
  const cookieHeader = buildSessionCookie(newSessionId, DEFAULT_SESSION_TTL_SECONDS, isProd);

  return { user, session, cookieHeader };
}

/**
 * Validates a session by ID, enforcing expiration, account status, and activity tracking.
 */
export async function validateSession(
  apiContext: ApiContext,
  sessionId: string,
): Promise<{ user: User; session: Session } | null> {
  const repo = apiContext.repository;
  const session = await repo.getSession(sessionId);

  if (!session) return null;

  if (new Date(session.expiresAt) < new Date()) {
    await repo.deleteSession(sessionId);
    return null;
  }

  const user = await repo.getUserById(session.userId);
  if (!user || user.status !== "active") {
    return null;
  }

  const updatedSession: Session = {
    ...session,
    lastActiveAt: new Date().toISOString(),
  };

  await repo.updateSession(updatedSession);
  return { user, session: updatedSession };
}

/**
 * Logout session by revoking the session token and generating a clearing cookie.
 */
export async function logoutSession(
  apiContext: ApiContext,
  sessionId: string | null,
): Promise<{ cookieHeader: string }> {
  if (sessionId) {
    await apiContext.repository.deleteSession(sessionId);
  }
  const isProd = import.meta.env?.PROD ?? false;
  return { cookieHeader: buildClearSessionCookie(isProd) };
}
