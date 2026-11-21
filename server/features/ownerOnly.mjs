/**
 * Features that aren't ready for everyone yet: only the accounts named in
 * OWNER_ONLY_FEATURE_EMAILS (comma-separated, set in the server's environment) can
 * see or use them. Everyone else gets no button in the app and a 403 from the API.
 * Unset means nobody, so the desktop app's local mode (no account) never has them.
 *
 * To hold back another feature, add its client feature id here and guard its routes
 * with `requireOwnerOnlyFeature`. To release one, remove it from this list.
 */
export const OWNER_ONLY_FEATURES = Object.freeze(["voice", "flashcards"]);

export function ownerOnlyFeatureEmails(env = process.env) {
  return new Set(String(env?.OWNER_ONLY_FEATURE_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean));
}

/** The held-back features this account may use; empty for everyone not on the list. */
export function ownerOnlyFeaturesFor(user, env = process.env) {
  const email = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
  if (!email || !ownerOnlyFeatureEmails(env).has(email)) return [];
  return [...OWNER_ONLY_FEATURES];
}

export function canUseOwnerOnlyFeature(user, feature, env = process.env) {
  if (!OWNER_ONLY_FEATURES.includes(feature)) return true;
  return ownerOnlyFeaturesFor(user, env).includes(feature);
}

/** Tells the app which held-back features to show for this account. */
export function withOwnerOnlyFeatures(user, env = process.env) {
  if (!user || typeof user !== "object") return user;
  return { ...user, ownerFeatures: ownerOnlyFeaturesFor(user, env) };
}

/**
 * API routes that belong only to a held-back feature. Recording transcription
 * (/api/dictation/transcribe) is left open because Language lessons made from a
 * recording use it too; voice typing's live words go through these.
 */
export const OWNER_ONLY_ROUTES = Object.freeze({
  dictationLive: "voice",
  dictationLiveFinish: "voice",
  dictationLiveRenew: "voice",
  // Review history copied to the account; without it the app keeps cards on the device only.
  flashcardsSync: "flashcards",
});
