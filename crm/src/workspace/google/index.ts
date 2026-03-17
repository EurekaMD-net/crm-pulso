/**
 * Google Workspace Provider
 *
 * Implements WorkspaceProvider using Google APIs (Gmail, Drive, Calendar, Slides, Sheets).
 */

import type { WorkspaceProvider } from "../types.js";
import * as mail from "./mail.js";
import * as files from "./files.js";
import * as calendar from "./calendar.js";

export class GoogleProvider implements WorkspaceProvider {
  readonly name = "google" as const;

  searchMail = mail.searchMail;
  readMail = mail.readMail;
  createDraft = mail.createDraft;
  sendMail = mail.sendMail;

  listFiles = files.listFiles;
  readFile = files.readFile;
  createDocument = files.createDocument;
  listModifiedFiles = files.listModifiedFiles;
  exportFileText = files.exportFileText;

  createEvent = calendar.createEvent;
}
