/**
 * Google Workspace Auth
 *
 * JWT-based authentication with domain-wide delegation for Gmail and Calendar.
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var containing the JSON key file contents.
 * Impersonates individual persona emails for sending as them.
 */

import { google } from "googleapis";
import { JWT } from "google-auth-library";

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send"];
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

/** Returns true if Google Workspace integration is configured. */
export function isGoogleEnabled(): boolean {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
}

function getServiceAccountKey(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
  return JSON.parse(raw);
}

/** Get an authenticated Gmail client impersonating the given email. */
export function getGmailClient(impersonateEmail: string) {
  const key = getServiceAccountKey();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: GMAIL_SCOPES,
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

/** Get a read-only Drive client impersonating the given email. */
export function getDriveClient(impersonateEmail: string) {
  const key = getServiceAccountKey();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: DRIVE_READONLY_SCOPES,
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
