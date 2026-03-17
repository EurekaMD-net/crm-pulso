/**
 * Workspace Provider Interface
 *
 * Provider-agnostic types for mail, files, and calendar operations.
 * Implementations: GoogleProvider (Phase 10.A), MicrosoftProvider (Phase 10.C).
 */

// ---------------------------------------------------------------------------
// Mail types
// ---------------------------------------------------------------------------

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
  draft_id?: string;
  message_id?: string;
  sent_directly?: boolean;
}

export interface SendResult {
  message_id: string | null;
}

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

export interface FileListResult {
  id: string;
  nombre: string;
  tipo: string;
  fecha: string;
}

export interface FileContent {
  nombre: string;
  contenido: string;
  tipo: string;
}

export interface FileCreateResult {
  archivo_id: string;
  nombre: string;
  tipo: string;
  enlace: string | null;
}

export type DocType = "documento" | "hoja_de_calculo" | "presentacion";

export interface SyncFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: number;
}

// ---------------------------------------------------------------------------
// Calendar types
// ---------------------------------------------------------------------------

export interface CalendarEventInput {
  titulo: string;
  descripcion?: string;
  fecha_inicio: string;
  fecha_fin: string;
  calendar_id?: string;
}

export interface CalendarEventResult {
  external_event_id: string | null;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface WorkspaceProvider {
  readonly name: "google" | "microsoft";

  // Mail
  searchMail(
    email: string,
    query: string,
    limit: number,
  ): Promise<MailSearchResult[]>;
  readMail(email: string, messageId: string): Promise<MailDetail>;
  createDraft(
    email: string,
    to: string,
    subject: string,
    bodyHtml: string,
  ): Promise<DraftResult>;
  sendMail(
    email: string,
    to: string,
    subject: string,
    bodyHtml: string,
  ): Promise<SendResult>;

  // Files
  listFiles(
    email: string,
    query?: string,
    folderId?: string,
    limit?: number,
  ): Promise<FileListResult[]>;
  readFile(email: string, fileId: string): Promise<FileContent>;
  createDocument(
    email: string,
    name: string,
    type: DocType,
    content?: string,
    folderId?: string,
  ): Promise<FileCreateResult>;

  // Doc sync (RAG pipeline)
  listModifiedFiles(email: string, since?: string): Promise<SyncFile[]>;
  exportFileText(
    email: string,
    fileId: string,
    mimeType: string,
  ): Promise<string>;

  // Calendar
  createEvent(
    email: string,
    event: CalendarEventInput,
  ): Promise<CalendarEventResult>;
}
