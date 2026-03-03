/**
 * Google Workspace Auth
 *
 * JWT-based authentication with domain-wide delegation for Gmail and Calendar.
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var containing the JSON key file contents.
 * Impersonates individual persona emails for sending as them.
 */

import { google } from 'googleapis';
import { JWT } from 'google-auth-library';

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send'];
const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

/** Returns true if Google Workspace integration is configured. */
export function isGoogleEnabled(): boolean {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
}

function getServiceAccountKey(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
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
  return google.gmail({ version: 'v1', auth });
}

/** Get an authenticated Calendar client impersonating the given email. */
export function getCalendarClient(impersonateEmail: string) {
  const auth = new JWT({
    email: getServiceAccountKey().client_email,
    key: getServiceAccountKey().private_key,
    scopes: CALENDAR_SCOPES,
    subject: impersonateEmail,
  });
  return google.calendar({ version: 'v3', auth });
}
