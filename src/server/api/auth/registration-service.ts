import type { RegistrationRequest, RegistrationResponse } from "@/features/identity/registration";
import { maskEmail } from "@/features/identity/registration";
import {
  checkDeviceLimit,
  checkEmailDomainLimit,
  checkInviteCode,
  checkIpLimit,
  checkUsernameReservationLimit,
} from "../abuse-service";
import type { ApiContext } from "../context";
import type { Credential, Profile, User } from "../domain";
import { ApiError } from "../errors";
import { hashPassword } from "./password";

const SIGNUP_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function generatedAccountAddress(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(55));
  return `G${Array.from(bytes, (byte) => BASE32[byte % BASE32.length]).join("")}`;
}

export async function registerWithPassword(
  apiContext: ApiContext,
  input: RegistrationRequest,
  ip = "unknown",
  deviceFingerprint = "unknown",
): Promise<RegistrationResponse> {
  const ipCheck = await checkIpLimit(
    apiContext.repository,
    ip,
    "registration",
    5,
    SIGNUP_RATE_LIMIT_WINDOW_SECONDS,
  );
  if (!ipCheck.allowed) {
    throw new ApiError(429, "too_many_requests", "Registration rate limit exceeded for IP", {
      retryAfterSeconds: ipCheck.retryAfterSeconds ?? SIGNUP_RATE_LIMIT_WINDOW_SECONDS,
    });
  }

  if (deviceFingerprint !== "unknown") {
    const deviceCheck = await checkDeviceLimit(apiContext.repository, deviceFingerprint, {
      route: "registration",
      windowMs: 3600_000,
      max: 3,
    });
    if (!deviceCheck.allowed) {
      throw new ApiError(429, "too_many_requests", "Registration limit exceeded for device", {
        retryAfterSeconds: deviceCheck.retryAfterSeconds ?? SIGNUP_RATE_LIMIT_WINDOW_SECONDS,
      });
    }
  }

  const domainCheck = await checkEmailDomainLimit(apiContext.repository, input.email);
  if (!domainCheck.allowed) {
    throw new ApiError(
      400,
      "bad_request",
      domainCheck.reason === "disposable_email_blocked"
        ? "Disposable email addresses are not accepted"
        : "Email domain registration limit reached",
    );
  }

  const usernameCheck = await checkUsernameReservationLimit(apiContext.repository, ip);
  if (!usernameCheck.allowed) {
    throw new ApiError(429, "too_many_requests", "Username reservation rate limit reached", {
      retryAfterSeconds: usernameCheck.retryAfterSeconds ?? SIGNUP_RATE_LIMIT_WINDOW_SECONDS,
    });
  }

  const inviteCheck = await checkInviteCode(apiContext.repository, input.inviteCode);
  if (!inviteCheck.allowed) {
    throw new ApiError(
      403,
      "forbidden",
      inviteCheck.reason === "invite_code_required"
        ? "An invite code is required during beta signup"
        : "Invalid invite code",
    );
  }

  const now = new Date().toISOString();
  const userId = `usr_${crypto.randomUUID().replace(/-/g, "")}`;
  const { hash, salt } = await hashPassword(input.password);
  const user: User = {
    userId,
    address: generatedAccountAddress(),
    email: input.email,
    username: input.username,
    status: "pending_verification",
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  const credential: Credential = {
    credentialId: `cred_${crypto.randomUUID().replace(/-/g, "")}`,
    userId,
    authMethod: "password_hash",
    secretHash: `${hash}:${salt}`,
    walletKeyRef: `pending_${userId}`,
    createdAt: now,
    updatedAt: now,
  };
  const profile: Profile = {
    userId,
    username: input.username,
    displayName: input.displayName,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await apiContext.repository.createUser(user, credential, profile);
  } catch (error) {
    if (error instanceof ApiError && error.code === "conflict") {
      throw new ApiError(409, "conflict", "Registration details conflict with an existing account");
    }
    throw error;
  }

  return {
    accountStatus: "pending_verification",
    email: user.email,
    maskedEmail: maskEmail(user.email),
    username: user.username,
  };
}
