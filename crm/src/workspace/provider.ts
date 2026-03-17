/**
 * Workspace Provider Factory
 *
 * Returns the configured workspace provider (Google or Microsoft).
 * Provider is selected via WORKSPACE_PROVIDER env var (default: google).
 */

import type { WorkspaceProvider } from "./types.js";

let cached: WorkspaceProvider | null = null;

export function getProvider(): WorkspaceProvider {
  if (cached) return cached;
  const name = process.env.WORKSPACE_PROVIDER || "google";
  if (name === "microsoft") {
    throw new Error(
      "Microsoft provider not yet implemented. Set WORKSPACE_PROVIDER=google or remove the env var.",
    );
  }
  // Dynamic import to support future Microsoft provider
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GoogleProvider } = require("./google/index.js") as {
    GoogleProvider: new () => WorkspaceProvider;
  };
  cached = new GoogleProvider();
  return cached!;
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
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
}

/** Reset cached provider (for testing). */
export function _resetProvider(): void {
  cached = null;
}
