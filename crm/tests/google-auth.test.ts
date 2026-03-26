/**
 * Google Auth Tests
 *
 * Tests isGoogleEnabled(), getGmailClient(), getCalendarClient().
 * Google API calls are not tested here — only auth setup and env detection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock googleapis and google-auth-library
vi.mock("googleapis", () => {
  const fakeGmail = { users: { messages: { send: vi.fn() } } };
  const fakeCalendar = { events: { insert: vi.fn(), list: vi.fn() } };
  return {
    google: {
      gmail: vi.fn(() => fakeGmail),
      calendar: vi.fn(() => fakeCalendar),
    },
  };
});

vi.mock("google-auth-library", () => {
  class MockJWT {
    email: string;
    subject: string;
    constructor(opts: any) {
      this.email = opts.email;
      this.subject = opts.subject;
    }
  }
  return { JWT: MockJWT };
});

const { isGoogleEnabled, getGmailClient, getCalendarClient } =
  await import("../src/google-auth.js");
const { _resetEnvCache } = await import("../src/workspace/google/auth.js");

// Block .env fallback: override cwd so readFileSync won't find a real .env
const originalCwd = process.cwd;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isGoogleEnabled", () => {
  afterEach(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    _resetEnvCache();
    process.cwd = originalCwd;
  });

  beforeEach(() => {
    _resetEnvCache();
    // Point cwd to a dir with no .env so fallback returns null
    process.cwd = () => "/tmp";
  });

  it("returns false when env not set", () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    expect(isGoogleEnabled()).toBe(false);
  });

  it("returns true when env is set", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({
      client_email: "test@project.iam.gserviceaccount.com",
      private_key:
        "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
    });
    expect(isGoogleEnabled()).toBe(true);
  });

  it("returns false for empty string", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "";
    expect(isGoogleEnabled()).toBe(false);
  });
});

describe("getGmailClient", () => {
  beforeEach(() => {
    _resetEnvCache();
    process.cwd = () => "/tmp";
  });
  afterEach(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    _resetEnvCache();
    process.cwd = originalCwd;
  });

  it("throws when env not set", () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    expect(() => getGmailClient("user@example.com")).toThrow(
      "GOOGLE_SERVICE_ACCOUNT_KEY not set",
    );
  });

  it("returns a gmail client when configured", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({
      client_email: "test@project.iam.gserviceaccount.com",
      private_key:
        "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
    });
    const client = getGmailClient("user@example.com");
    expect(client).toBeDefined();
    expect(client.users).toBeDefined();
  });
});

describe("getCalendarClient", () => {
  beforeEach(() => {
    _resetEnvCache();
    process.cwd = () => "/tmp";
  });
  afterEach(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    _resetEnvCache();
    process.cwd = originalCwd;
  });

  it("throws when env not set", () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    expect(() => getCalendarClient("user@example.com")).toThrow(
      "GOOGLE_SERVICE_ACCOUNT_KEY not set",
    );
  });

  it("returns a calendar client when configured", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({
      client_email: "test@project.iam.gserviceaccount.com",
      private_key:
        "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
    });
    const client = getCalendarClient("user@example.com");
    expect(client).toBeDefined();
    expect(client.events).toBeDefined();
  });
});

describe("graceful fallback", () => {
  beforeEach(() => {
    _resetEnvCache();
    process.cwd = () => "/tmp";
  });
  afterEach(() => {
    _resetEnvCache();
    process.cwd = originalCwd;
  });

  it("isGoogleEnabled false does not crash", () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    expect(isGoogleEnabled()).toBe(false);
    // No crash — code should check isGoogleEnabled() before calling getGmailClient
  });
});
