/**
 * Google Workspace Expansion Tests
 *
 * Tests new client factories: getGmailReadClient, getDriveClient, getCalendarReadClient.
 * Validates scope isolation between read-only and write clients.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Track constructor calls to verify scopes
const jwtInstances: Array<{
  email: string;
  subject: string;
  scopes: string[];
}> = [];

vi.mock("googleapis", () => {
  const fakeGmail = {
    users: {
      messages: { send: vi.fn(), list: vi.fn(), get: vi.fn() },
      drafts: { create: vi.fn() },
    },
  };
  const fakeCalendar = { events: { insert: vi.fn(), list: vi.fn() } };
  const fakeDrive = { files: { list: vi.fn(), get: vi.fn(), export: vi.fn() } };
  return {
    google: {
      gmail: vi.fn(() => fakeGmail),
      calendar: vi.fn(() => fakeCalendar),
      drive: vi.fn(() => fakeDrive),
    },
  };
});

vi.mock("google-auth-library", () => {
  class MockJWT {
    email: string;
    subject: string;
    scopes: string[];
    constructor(opts: any) {
      this.email = opts.email;
      this.subject = opts.subject;
      this.scopes = opts.scopes;
      jwtInstances.push({
        email: opts.email,
        subject: opts.subject,
        scopes: opts.scopes,
      });
    }
  }
  return { JWT: MockJWT };
});

const {
  isGoogleEnabled,
  getGmailClient,
  getGmailReadClient,
  getCalendarClient,
  getCalendarReadClient,
  getDriveClient,
} = await import("../src/google-auth.js");
const { _resetEnvCache } = await import("../src/workspace/google/auth.js");
const originalCwd = process.cwd;

const TEST_KEY = JSON.stringify({
  client_email: "test@project.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
});

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

describe("new client factories", () => {
  beforeEach(() => {
    _resetEnvCache();
    process.cwd = () => "/tmp";
  });
  afterEach(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    jwtInstances.length = 0;
    _resetEnvCache();
    process.cwd = originalCwd;
  });

  it("getGmailReadClient returns an object", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = TEST_KEY;
    const client = getGmailReadClient("user@example.com");
    expect(client).toBeDefined();
    expect(client.users).toBeDefined();
  });

  it("getDriveClient returns an object", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = TEST_KEY;
    const client = getDriveClient("user@example.com");
    expect(client).toBeDefined();
    expect(client.files).toBeDefined();
  });

  it("getCalendarReadClient returns an object", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = TEST_KEY;
    const client = getCalendarReadClient("user@example.com");
    expect(client).toBeDefined();
    expect(client.events).toBeDefined();
  });

  it("getGmailReadClient throws when env not set", () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    expect(() => getGmailReadClient("user@example.com")).toThrow(
      "GOOGLE_SERVICE_ACCOUNT_KEY not set",
    );
  });

  it("getDriveClient throws when env not set", () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    expect(() => getDriveClient("user@example.com")).toThrow(
      "GOOGLE_SERVICE_ACCOUNT_KEY not set",
    );
  });

  it("getCalendarReadClient throws when env not set", () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    expect(() => getCalendarReadClient("user@example.com")).toThrow(
      "GOOGLE_SERVICE_ACCOUNT_KEY not set",
    );
  });
});

// ---------------------------------------------------------------------------
// Scope isolation
// ---------------------------------------------------------------------------

describe("scope isolation", () => {
  afterEach(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    jwtInstances.length = 0;
  });

  it("getGmailClient uses gmail.send scope", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = TEST_KEY;
    jwtInstances.length = 0;
    getGmailClient("user@example.com");
    expect(jwtInstances[0].scopes).toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
  });

  it("getGmailReadClient uses gmail.readonly scope", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = TEST_KEY;
    jwtInstances.length = 0;
    getGmailReadClient("user@example.com");
    expect(jwtInstances[0].scopes).toContain(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
    expect(jwtInstances[0].scopes).not.toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
  });

  it("getCalendarClient uses calendar.events scope", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = TEST_KEY;
    jwtInstances.length = 0;
    getCalendarClient("user@example.com");
    expect(jwtInstances[0].scopes).toContain(
      "https://www.googleapis.com/auth/calendar.events",
    );
  });

  it("getCalendarReadClient uses calendar.readonly scope", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = TEST_KEY;
    jwtInstances.length = 0;
    getCalendarReadClient("user@example.com");
    expect(jwtInstances[0].scopes).toContain(
      "https://www.googleapis.com/auth/calendar.readonly",
    );
    expect(jwtInstances[0].scopes).not.toContain(
      "https://www.googleapis.com/auth/calendar.events",
    );
  });

  it("getDriveClient uses full drive scope", () => {
    // Uses full drive scope intentionally — drive.readonly requires separate
    // domain-wide delegation authorization, full scope avoids mismatch errors
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = TEST_KEY;
    jwtInstances.length = 0;
    getDriveClient("user@example.com");
    expect(jwtInstances[0].scopes).toContain(
      "https://www.googleapis.com/auth/drive",
    );
  });

  it("each client has its own isolated scopes", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = TEST_KEY;
    jwtInstances.length = 0;
    getGmailClient("a@test.com");
    getGmailReadClient("b@test.com");
    getCalendarClient("c@test.com");
    getCalendarReadClient("d@test.com");
    getDriveClient("e@test.com");

    expect(jwtInstances).toHaveLength(5);
    // All scopes are different
    const allScopes = jwtInstances.map((j) => j.scopes[0]);
    const uniqueScopes = new Set(allScopes);
    expect(uniqueScopes.size).toBe(5);
  });
});
