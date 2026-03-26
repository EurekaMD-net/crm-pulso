/**
 * Workspace Provider Factory
 *
 * Returns the configured workspace provider (Google or Microsoft).
 * Provider is selected via WORKSPACE_PROVIDER env var (default: google).
 *
 * Checks both process.env (set inside containers via stdin secrets)
 * and the .env file (host-side for doc-sync and other host processes).
 */

import type { WorkspaceProvider } from "./types.js";
import { GoogleProvider } from "./google/index.js";
import { getGoogleServiceAccountKey } from "./google/auth.js";

let cached: WorkspaceProvider | null = null;

export function getProvider(): WorkspaceProvider {
  if (cached) return cached;
  const name = process.env.WORKSPACE_PROVIDER || "google";
  if (name === "microsoft") {
    throw new Error(
      "Microsoft provider not yet implemented. Set WORKSPACE_PROVIDER=google or remove the env var.",
    );
  }
  cached = new GoogleProvider();
  return cached;
}

export function isWorkspaceEnabled(): boolean {
  const name = process.env.WORKSPACE_PROVIDER || "google";
  if (name === "microsoft") {
    return !!(
      process.env.MICROSOFT_TENANT_ID &&
      process.env.MICROSOFT_CLIENT_ID &&
      process.env.MICROSOFT_CLIENT_SECRET
    );
  }
  return !!getGoogleServiceAccountKey();
}

/** Reset cached provider (for testing). */
export function _resetProvider(): void {
  cached = null;
}
