/**
 * Google Auth Tests
 *
 * Tests isGoogleEnabled(), getGmailClient(), getCalendarClient().
 * Google API calls are not tested here — only auth setup and env detection.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// Mock readEnvFile so .env fallback doesn't interfere with env-based tests
vi.mock("../../engine/src/env.js", () => ({
  readEnvFile: () => ({}),
}));

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isGoogleEnabled", () => {
  afterEach(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
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
  afterEach(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
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
  afterEach(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
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
  it("isGoogleEnabled false does not crash", () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    expect(isGoogleEnabled()).toBe(false);
    // No crash — code should check isGoogleEnabled() before calling getGmailClient
  });
});
