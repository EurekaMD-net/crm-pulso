/**
 * Google Workspace Auth
 *
 * JWT-based authentication with domain-wide delegation for Gmail, Calendar, Drive, Slides, Sheets.
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var containing the JSON key file contents.
 * Impersonates individual persona emails for accessing their data.
 *
 * Key resolution: checks process.env first (container via stdin), then .env
 * file on disk (host process for doc-sync, warmth scheduler, etc.).
 */

import { google } from "googleapis";
import { JWT } from "google-auth-library";
import { readEnvFile } from "../../../../engine/src/env.js";

const GMAIL_SEND_SCOPES = ["https://www.googleapis.com/auth/gmail.send"];
const GMAIL_COMPOSE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
];
const GMAIL_READONLY_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events"];
const CALENDAR_READONLY_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
];
const DRIVE_READONLY_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
];
const DRIVE_FULL_SCOPES = ["https://www.googleapis.com/auth/drive"];
const SLIDES_SCOPES = ["https://www.googleapis.com/auth/presentations"];
const SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

/**
 * Get the raw GOOGLE_SERVICE_ACCOUNT_KEY value from process.env or .env file.
 * Returns null if not configured in either location.
 */
export function getGoogleServiceAccountKey(): string | null {
  // Container path: set via stdin secrets → process.env
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  }
  // Host path: read directly from .env file (never loaded into process.env)
  const env = readEnvFile(["GOOGLE_SERVICE_ACCOUNT_KEY"]);
  return env.GOOGLE_SERVICE_ACCOUNT_KEY || null;
}

/** Returns true if Google Workspace integration is configured. */
export function isGoogleEnabled(): boolean {
  return !!getGoogleServiceAccountKey();
}

function getServiceAccountKey(): { client_email: string; private_key: string } {
  const raw = getGoogleServiceAccountKey();
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
  return JSON.parse(raw);
}

/** Get a Gmail client for sending messages (gmail.send scope only). */
export function getGmailClient(impersonateEmail: string) {
  const key = getServiceAccountKey();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: GMAIL_SEND_SCOPES,
    subject: impersonateEmail,
  });
  return google.gmail({ version: "v1", auth });
}

/** Get a Gmail client for creating drafts (requires gmail.compose scope). */
export function getGmailComposeClient(impersonateEmail: string) {
  const key = getServiceAccountKey();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: GMAIL_COMPOSE_SCOPES,
    subject: impersonateEmail,
  });
  return google.gmail({ version: "v1", auth });
}

/** Get a read-only Gmail client impersonating the given email. */
export function getGmailReadClient(impersonateEmail: string) {
  const key = getServiceAccountKey();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: GMAIL_READONLY_SCOPES,
    subject: impersonateEmail,
  });
  return google.gmail({ version: "v1", auth });
}

/** Get an authenticated Calendar client impersonating the given email. */
export function getCalendarClient(impersonateEmail: string) {
  const key = getServiceAccountKey();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: CALENDAR_SCOPES,
    subject: impersonateEmail,
  });
  return google.calendar({ version: "v3", auth });
}

/** Get a read-only Calendar client impersonating the given email. */
export function getCalendarReadClient(impersonateEmail: string) {
  const key = getServiceAccountKey();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: CALENDAR_READONLY_SCOPES,
    subject: impersonateEmail,
  });
  return google.calendar({ version: "v3", auth });
}

/** Get a Drive client impersonating the given email. Uses full drive scope
 *  because drive.readonly must be separately authorized in domain-wide
 *  delegation — using the full scope avoids scope mismatch errors. */
export function getDriveClient(impersonateEmail: string) {
  const key = getServiceAccountKey();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: DRIVE_FULL_SCOPES,
    subject: impersonateEmail,
  });
  return google.drive({ version: "v3", auth });
}

/** Get a full-access Drive client (create, edit, delete files). */
export function getDriveWriteClient(impersonateEmail: string) {
  const key = getServiceAccountKey();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: DRIVE_FULL_SCOPES,
    subject: impersonateEmail,
  });
  return google.drive({ version: "v3", auth });
}

/** Get a Google Slides client for creating/editing presentations. */
export function getSlidesClient(impersonateEmail: string) {
  const key = getServiceAccountKey();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SLIDES_SCOPES,
    subject: impersonateEmail,
  });
  return google.slides({ version: "v1", auth });
}

/** Get a Google Sheets client for creating/editing spreadsheets. */
export function getSheetsClient(impersonateEmail: string) {
  const key = getServiceAccountKey();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SHEETS_SCOPES,
    subject: impersonateEmail,
  });
  return google.sheets({ version: "v4", auth });
}
