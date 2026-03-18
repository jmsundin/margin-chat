import { createStatusError } from "../lib/errors.mjs";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeLoginPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createStatusError(400, "Login payload must be a JSON object.");
  }

  return {
    email: normalizeEmail(input.email),
    password: normalizePassword(input.password, {
      maxLength: 200,
      message: "Password is required.",
      minLength: 1,
    }),
  };
}

export function normalizeSignupPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createStatusError(400, "Signup payload must be a JSON object.");
  }

  return {
    displayName: normalizeDisplayName(input.displayName),
    email: normalizeEmail(input.email),
    password: normalizePassword(input.password, {
      maxLength: 200,
      message: "Password must be at least 8 characters.",
      minLength: 8,
    }),
  };
}

export function normalizeProfileUpdatePayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createStatusError(400, "Profile payload must be a JSON object.");
  }

  return {
    displayName: normalizeDisplayName(input.displayName),
    email: normalizeEmail(input.email),
  };
}

function normalizeDisplayName(value) {
  if (typeof value !== "string") {
    throw createStatusError(400, "Display name is required.");
  }

  const normalized = value.trim().replace(/\s+/g, " ");

  if (normalized.length < 2 || normalized.length > 80) {
    throw createStatusError(
      400,
      "Display name must be between 2 and 80 characters.",
    );
  }

  return normalized;
}

function normalizeEmail(value) {
  if (typeof value !== "string") {
    throw createStatusError(400, "Email is required.");
  }

  const normalized = value.trim().toLowerCase();

  if (!EMAIL_PATTERN.test(normalized)) {
    throw createStatusError(400, "Enter a valid email address.");
  }

  if (normalized.length > 320) {
    throw createStatusError(400, "Email address is too long.");
  }

  return normalized;
}

function normalizePassword(value, options) {
  if (typeof value !== "string") {
    throw createStatusError(400, options.message);
  }

  if (value.length < options.minLength || value.length > options.maxLength) {
    throw createStatusError(400, options.message);
  }

  return value;
}
