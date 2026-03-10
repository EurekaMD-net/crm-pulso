# Workspace Abstraction Plan — Google + Microsoft

## Goal

Support both Google Workspace and Microsoft 365 as interchangeable backends for mail, files, and calendar. Org-wide toggle via `WORKSPACE_PROVIDER` env var. No per-user mixing.

## Current State

8 workspace tools hardcoded to Google APIs across 4 files:

| Tool | File | Google API |
|------|------|-----------|
| `buscar_emails` | `tools/gmail.ts` | `gmail.users.messages.list` |
| `leer_email` | `tools/gmail.ts` | `gmail.users.messages.get` |
| `crear_borrador_email` | `tools/gmail.ts` | `gmail.users.drafts.create` |
| `confirmar_envio_email` | `tools/email.ts` | `gmail.users.messages.send` |
| `enviar_email_briefing` | `tools/email.ts` | `gmail.users.messages.send` |
| `listar_archivos_drive` | `tools/drive.ts` | `drive.files.list` |
| `leer_archivo_drive` | `tools/drive.ts` | `drive.files.get/export` |
| `crear_evento_calendario` | `tools/calendar.ts` | `calendar.events.insert` |

Plus `doc-sync.ts` uses Drive API for RAG document synchronization.

Auth: `google-auth.ts` — JWT service account with domain-wide delegation, impersonates each user's email.

---

## Target Architecture

```
Tool handlers (tools/gmail.ts, drive.ts, calendar.ts, email.ts)
       │ call getProvider()
       ▼
crm/src/workspace/
  ├── types.ts           ← Provider interface + shared types
  ├── provider.ts        ← Factory: reads WORKSPACE_PROVIDER, returns impl
  ├── google/
  │   ├── auth.ts        ← JWT service account (moved from google-auth.ts)
  │   ├── mail.ts        ← Gmail API calls
  │   ├── files.ts       ← Drive API calls
  │   └── calendar.ts    ← Calendar API calls
  └── microsoft/
      ├── auth.ts        ← Azure AD client credentials + MS Graph client
      ├── mail.ts        ← Outlook/Exchange via Graph API
      ├── files.ts       ← SharePoint via Graph API
      └── calendar.ts    ← Outlook Calendar via Graph API
```

---

## Phase A — Interface + Google Refactor

**Goal:** Extract provider interface, move Google code behind it. Zero behavioral change.

### A1. Create provider interface

File: `crm/src/workspace/types.ts`

```ts
// --- Mail ---
export interface MailSearchResult {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface MailDetail {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

export interface DraftResult {
  draft_id: string;
}

export interface SendResult {
  message_id: string | null;
}

// --- Files ---
export interface FileListResult {
  id: string;
  nombre: string;
  tipo: string;       // MIME type
  fecha: string;       // ISO modified date
}

export interface FileContent {
  nombre: string;
  contenido: string;   // text content, truncated to 50KB
  tipo: string;
}

export interface SyncFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: number;
}

// --- Calendar ---
export interface CalendarEventInput {
  titulo: string;
  descripcion?: string;
  fecha_inicio: string;  // ISO
  fecha_fin: string;     // ISO
  calendar_id?: string;  // optional per-user calendar
}

export interface CalendarEventResult {
  external_event_id: string | null;
}

// --- Provider ---
export interface WorkspaceProvider {
  readonly name: 'google' | 'microsoft';

  // Mail
  searchMail(email: string, query: string, limit: number): Promise<MailSearchResult[]>;
  readMail(email: string, messageId: string): Promise<MailDetail>;
  createDraft(email: string, to: string, subject: string, body: string): Promise<DraftResult>;
  sendMail(email: string, to: string, subject: string, body: string): Promise<SendResult>;

  // Files
  listFiles(email: string, query?: string, folderId?: string, limit?: number): Promise<FileListResult[]>;
  readFile(email: string, fileId: string): Promise<FileContent>;

  // Doc sync
  listModifiedFiles(email: string, since?: string): Promise<SyncFile[]>;
  exportFileText(email: string, fileId: string, mimeType: string): Promise<string>;

  // Calendar
  createEvent(email: string, event: CalendarEventInput): Promise<CalendarEventResult>;
}
```

### A2. Move Google code into provider

- Move `google-auth.ts` → `workspace/google/auth.ts` (re-export from old path for compat during transition)
- Create `workspace/google/mail.ts` — extract Gmail logic from `tools/gmail.ts`
- Create `workspace/google/files.ts` — extract Drive logic from `tools/drive.ts` + `doc-sync.ts`
- Create `workspace/google/calendar.ts` — extract Calendar logic from `tools/calendar.ts`
- Create `workspace/google/index.ts` — class `GoogleProvider implements WorkspaceProvider`

### A3. Create provider factory

File: `crm/src/workspace/provider.ts`

```ts
import type { WorkspaceProvider } from './types.js';

let cached: WorkspaceProvider | null = null;

export function getProvider(): WorkspaceProvider {
  if (cached) return cached;
  const name = process.env.WORKSPACE_PROVIDER || 'google';
  if (name === 'microsoft') {
    const { MicrosoftProvider } = require('./microsoft/index.js');
    cached = new MicrosoftProvider();
  } else {
    const { GoogleProvider } = require('./google/index.js');
    cached = new GoogleProvider();
  }
  return cached;
}

export function isWorkspaceEnabled(): boolean {
  const name = process.env.WORKSPACE_PROVIDER || 'google';
  if (name === 'microsoft') {
    return !!(process.env.MICROSOFT_TENANT_ID && process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
  }
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
}
```

### A4. Rewrite tool handlers

Each tool handler becomes a thin wrapper:

```ts
// tools/gmail.ts (after refactor)
import { getProvider, isWorkspaceEnabled } from '../workspace/provider.js';

export async function buscar_emails(args, ctx): Promise<string> {
  if (!isWorkspaceEnabled()) return JSON.stringify({ error: 'Correo no configurado' });
  const email = getPersonaEmail(ctx.persona_id);
  if (!email) return JSON.stringify({ error: 'Persona no tiene email configurado' });
  try {
    const results = await getProvider().searchMail(email, args.query ?? '', args.limite ?? 10);
    return JSON.stringify({ emails: results });
  } catch (err) {
    return JSON.stringify({ error: `Error buscando emails: ${err.message?.slice(0, 200)}` });
  }
}
```

Same pattern for all 8 tools.

### A5. Rewrite doc-sync.ts

Replace `getDriveClient()` calls with `getProvider().listModifiedFiles()` and `getProvider().exportFileText()`.

### A6. Verify

- `npm run typecheck` — clean
- `npm run test` — all 361 CRM tests pass
- Manual smoke test: send a message, confirm Gmail/Drive/Calendar still work

### Files touched in Phase A

| Action | File |
|--------|------|
| NEW | `crm/src/workspace/types.ts` |
| NEW | `crm/src/workspace/provider.ts` |
| NEW | `crm/src/workspace/google/auth.ts` |
| NEW | `crm/src/workspace/google/mail.ts` |
| NEW | `crm/src/workspace/google/files.ts` |
| NEW | `crm/src/workspace/google/calendar.ts` |
| NEW | `crm/src/workspace/google/index.ts` |
| MODIFY | `crm/src/tools/gmail.ts` — thin wrappers |
| MODIFY | `crm/src/tools/drive.ts` — thin wrappers |
| MODIFY | `crm/src/tools/calendar.ts` — use provider for Google sync |
| MODIFY | `crm/src/tools/email.ts` — use provider for send |
| MODIFY | `crm/src/doc-sync.ts` — use provider for Drive sync |
| DELETE | `crm/src/google-auth.ts` (moved to workspace/google/auth.ts) |
| MODIFY | Tests as needed for new import paths |

---

## Phase B — Microsoft Provider

**Goal:** Implement Microsoft 365 backend via MS Graph API.

### B1. Auth — Azure AD Client Credentials

File: `crm/src/workspace/microsoft/auth.ts`

**Azure AD Setup (one-time, manual):**
1. Register app in Azure AD → get `client_id`
2. Create client secret → get `client_secret`
3. Grant application permissions:
   - `Mail.ReadWrite` — search, read, draft, send mail as any user
   - `Sites.Read.All` — read SharePoint files
   - `Calendars.ReadWrite` — create/read calendar events
4. Admin consent granted for the tenant

**Auth flow:**
```ts
// OAuth2 client credentials grant
POST https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token
  grant_type=client_credentials
  client_id={client_id}
  client_secret={client_secret}
  scope=https://graph.microsoft.com/.default
```

Token cached with TTL (default 3600s, refresh before expiry).

**Impersonation:** MS Graph application permissions allow accessing any user's mailbox, calendar, and files via `/users/{email}/...` endpoints. No per-user consent needed — same model as Google's domain-wide delegation.

```ts
import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';

let graphClient: Client | null = null;

export function getGraphClient(): Client {
  if (graphClient) return graphClient;
  const credential = new ClientSecretCredential(
    process.env.MICROSOFT_TENANT_ID!,
    process.env.MICROSOFT_CLIENT_ID!,
    process.env.MICROSOFT_CLIENT_SECRET!,
  );
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
  graphClient = Client.initWithMiddleware({ authProvider });
  return graphClient;
}
```

### B2. Mail — Outlook via Graph

File: `crm/src/workspace/microsoft/mail.ts`

| Method | Graph API Endpoint |
|--------|-------------------|
| `searchMail` | `GET /users/{email}/messages?$search="..."&$top={limit}&$select=id,from,subject,receivedDateTime,bodyPreview` |
| `readMail` | `GET /users/{email}/messages/{id}?$select=from,toRecipients,subject,receivedDateTime,body` |
| `createDraft` | `POST /users/{email}/messages` with body `{ subject, body: { contentType: 'HTML', content }, toRecipients: [...], isDraft: true }` |
| `sendMail` | `POST /users/{email}/sendMail` with body `{ message: { subject, body, toRecipients }, saveToSentItems: true }` |

**Field mapping:**
- Gmail `From` header → Graph `from.emailAddress.address`
- Gmail `snippet` → Graph `bodyPreview`
- Gmail `Date` → Graph `receivedDateTime`
- Gmail base64url body → Graph `body.content` (HTML or text, no decoding needed)
- Gmail `messages.list` + per-message `get` → Graph returns all fields in one call (more efficient)

### B3. Files — SharePoint via Graph

File: `crm/src/workspace/microsoft/files.ts`

**Config:** `MICROSOFT_SHAREPOINT_SITE_ID` env var — the SharePoint site where company documents live.

| Method | Graph API Endpoint |
|--------|-------------------|
| `listFiles` | `GET /sites/{siteId}/drive/root/search(q='{query}')` or `GET /sites/{siteId}/drive/items/{folderId}/children` |
| `readFile` | `GET /sites/{siteId}/drive/items/{id}/content` (downloads file). For Office docs: `GET /sites/{siteId}/drive/items/{id}/content?format=pdf` or use preview endpoint |
| `listModifiedFiles` | `GET /sites/{siteId}/drive/root/delta` with `$filter=lastModifiedDateTime gt {since}` |
| `exportFileText` | Download content + extract text. For .docx/.xlsx/.pptx: use `mammoth` (docx→text), `xlsx` (sheets→text), or just download as PDF and `pdftotext` |

**Key difference from Google:** Google Docs are native and need `export()`. Office files on SharePoint are standard .docx/.xlsx — download + local text extraction.

**Text extraction for Office files:**
- `.docx` → `mammoth` npm package (already lightweight, no native deps)
- `.xlsx` → `xlsx` npm package (read cells as text)
- `.pptx` → extract XML text from OOXML zip
- `.pdf` → `pdftotext` (already installed on host)
- `.txt/.csv/.md` → direct read

### B4. Calendar — Outlook Calendar via Graph

File: `crm/src/workspace/microsoft/calendar.ts`

| Method | Graph API Endpoint |
|--------|-------------------|
| `createEvent` | `POST /users/{email}/calendar/events` with body `{ subject, body: { content }, start: { dateTime, timeZone }, end: { dateTime, timeZone } }` |

**Field mapping:**
- Google `summary` → Graph `subject`
- Google `description` → Graph `body.content`
- Google `start.dateTime` → Graph `start.dateTime` + `start.timeZone: 'America/Mexico_City'`
- Google event ID → Graph event ID (stored in `external_event_id`)

### B5. Provider class

File: `crm/src/workspace/microsoft/index.ts`

```ts
export class MicrosoftProvider implements WorkspaceProvider {
  readonly name = 'microsoft' as const;
  // delegates to mail.ts, files.ts, calendar.ts
}
```

### New dependencies

```
@azure/identity              — Azure AD auth
@microsoft/microsoft-graph-client — MS Graph SDK
mammoth                       — .docx text extraction (for doc-sync)
```

### Files in Phase B

| Action | File |
|--------|------|
| NEW | `crm/src/workspace/microsoft/auth.ts` |
| NEW | `crm/src/workspace/microsoft/mail.ts` |
| NEW | `crm/src/workspace/microsoft/files.ts` |
| NEW | `crm/src/workspace/microsoft/calendar.ts` |
| NEW | `crm/src/workspace/microsoft/index.ts` |
| MODIFY | `package.json` — add 3 dependencies |
| NEW | `crm/tests/microsoft-provider.test.ts` |

---

## Phase C — Config & Schema Cleanup

### C1. Schema renames

```sql
-- persona table
ALTER TABLE persona RENAME COLUMN google_calendar_id TO calendar_id;

-- evento_calendario table
ALTER TABLE evento_calendario RENAME COLUMN google_event_id TO external_event_id;
```

Update all references in:
- `crm/src/schema.ts` — column definitions
- `crm/src/tools/calendar.ts` — INSERT/SELECT queries
- `crm/tests/` — any tests referencing old column names

### C2. Environment variables

```env
# Provider switch (default: google)
WORKSPACE_PROVIDER=google|microsoft

# --- Google (when WORKSPACE_PROVIDER=google) ---
GOOGLE_SERVICE_ACCOUNT_KEY=<JSON key contents>
GOOGLE_CALENDAR_ENABLED=true|false

# --- Microsoft (when WORKSPACE_PROVIDER=microsoft) ---
MICROSOFT_TENANT_ID=<azure-ad-tenant-id>
MICROSOFT_CLIENT_ID=<app-registration-client-id>
MICROSOFT_CLIENT_SECRET=<client-secret>
MICROSOFT_SHAREPOINT_SITE_ID=<sharepoint-site-id>
```

### C3. CLAUDE.md template updates

Replace platform-specific language in tool descriptions:

| Before | After |
|--------|-------|
| `Gmail` | `correo` |
| `Google Drive` | `archivos compartidos` |
| `Google Calendar` | `calendario` |
| `buscar emails en tu bandeja` | `buscar emails en tu bandeja` (already generic) |
| `(sincronizado con Google Calendar)` | `(sincronizado con calendario)` |
| `Google Calendar no configurado` | `Calendario externo no configurado` |
| `Gmail no configurado` | `Correo no configurado` |
| `Google Drive no configurado` | `Archivos no configurados` |

Tool names stay the same — `buscar_emails`, `leer_email`, `listar_archivos_drive`, etc. Renaming `listar_archivos_drive` → `listar_archivos` is optional (breaking change for session history, minor benefit).

### C4. Update docs

- `README.md` — mention both platforms
- `docs/ARCHITECTURE.md` — update section 9 (Google Workspace) to cover both
- `docs/DEPLOYMENT.md` — add Microsoft setup steps

---

## Execution Order

```
Phase A (interface + Google refactor)     ← Do first. No new functionality.
  ↓                                         Validates the abstraction works.
Phase C (schema + config + docs)          ← Do second. Renames while refactoring.
  ↓
Phase B (Microsoft implementation)        ← Do last. New functionality.
                                            Can be done when Azure AD app is ready.
```

Phase A and C can be done now. Phase B requires Azure AD app registration (needs IT admin access to the Microsoft tenant).

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| MS Graph rate limits (10,000 req/10min per app) | Generous for 50 users. Cache token, batch where possible |
| SharePoint search slower than Drive | `delta` endpoint for incremental sync; full search acceptable for interactive |
| Office doc text extraction quality | `mammoth` for .docx is mature. Fallback: download as PDF + `pdftotext` |
| Azure AD app permissions need admin consent | One-time setup. Document exact permissions needed |
| Token expiry mid-request | `@azure/identity` handles refresh automatically |

## Azure AD Setup Checklist (for IT admin)

1. Go to Azure Portal → Azure Active Directory → App registrations → New
2. Name: `CRM Azteca Agent`
3. Supported account types: Single tenant
4. No redirect URI needed (daemon/service app)
5. Certificates & secrets → New client secret → copy value
6. API permissions → Add:
   - `Mail.ReadWrite` (Application)
   - `Mail.Send` (Application)
   - `Sites.Read.All` (Application)
   - `Calendars.ReadWrite` (Application)
7. Grant admin consent
8. Copy: Tenant ID, Client ID, Client Secret
9. Find SharePoint site ID:
   ```
   GET https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}
   ```
