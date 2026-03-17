/**
 * Google Auth — Re-export shim
 *
 * Original code moved to workspace/google/auth.ts.
 * This file re-exports for backward compatibility with:
 * - bootstrap.ts (isGoogleEnabled check)
 * - tests (google-auth.test.ts, google-workspace.test.ts)
 * - container agent-runner mocks
 */

export {
  isGoogleEnabled,
  getGmailClient,
  getGmailComposeClient,
  getGmailReadClient,
  getCalendarClient,
  getCalendarReadClient,
  getDriveClient,
  getDriveWriteClient,
  getSlidesClient,
  getSheetsClient,
} from "./workspace/google/auth.js";
