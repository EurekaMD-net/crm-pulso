/**
 * CRM Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Uses the CRM inference adapter (OpenAI-compatible) instead of Claude Agent SDK.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages as JSON files in /workspace/ipc/input/
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result wrapped in ---NANOCLAW_OUTPUT_START/END--- markers.
 */

import fs from "fs";
import path from "path";
import { bootstrapCrm } from "../../src/bootstrap.js";
import { getDatabase } from "../../../engine/src/db.js";
import {
  getPersonByGroupFolder,
  getPersonById,
  getDirectReports,
  getManager,
} from "../../src/hierarchy.js";
import type { Persona } from "../../src/hierarchy.js";
import {
  buildToolContext,
  executeTool,
  getToolsForRole,
} from "../../src/tools/index.js";
import {
  getUserProfile,
  formatProfileSection,
} from "../../src/tools/perfil.js";
import { inferWithTools } from "../../src/inference-adapter.js";
import type {
  ChatMessage,
  ToolDefinition,
} from "../../src/inference-adapter.js";
import type { ToolContext } from "../../src/tools/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
}

interface ContainerOutput {
  status: "success" | "error";
  result: string | null;
  newSessionId?: string;
  error?: string;
  streaming?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IPC_INPUT_DIR = "/workspace/ipc/input";
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, "_close");
const IPC_POLL_MIN_MS = 100;
const IPC_POLL_MAX_MS = 500;
const MAX_MESSAGES = 30;
const MAX_SESSION_CHARS = 20_000; // Character budget for session (prevents prompt bloat with large creative content)
const MAX_TOOL_ROUNDS = 15;
const SESSIONS_DIR = "/workspace/group/.crm-sessions";

const OUTPUT_START_MARKER = "---NANOCLAW_OUTPUT_START---";
const OUTPUT_END_MARKER = "---NANOCLAW_OUTPUT_END---";

// Fixed acknowledgment message — no LLM tokens wasted
const ACK_MESSAGE = "Un momento...";

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.error(`[crm-agent-runner] ${message}`);
}

/**
 * Strip CJK characters that Chinese LLMs (GLM-5, Qwen) occasionally leak.
 * Preserves all Latin, Spanish diacritics, punctuation, emoji, and whitespace.
 */
function stripCJK(text: string): string {
  // CJK Unified Ideographs + CJK Compatibility + Bopomofo + Katakana + Hangul
  return text
    .replace(/[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function writeOutput(output: ContainerOutput): void {
  if (output.result) {
    output.result = stripCJK(output.result);
  }
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        fs.unlinkSync(filePath);
        if (data.type === "message" && data.text) {
          messages.push(data.text.replace(/@CRM\s*/gi, "").trim());
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    let pollMs = IPC_POLL_MIN_MS;
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join("\n"));
        return;
      }
      pollMs = Math.min(pollMs * 1.5, IPC_POLL_MAX_MS);
      setTimeout(poll, pollMs);
    };
    poll();
  });
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

function loadSession(sessionId: string): ChatMessage[] | null {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    log(
      `Failed to load session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function saveSession(sessionId: string, messages: ChatMessage[]): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  const tmpPath = filePath + ".tmp";
  // Don't persist system prompt — it's rebuilt from templates on load.
  // Strip image_url blocks from multimodal content — keep text reference only
  // to avoid bloating session files with base64 data.
  const toSave = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (Array.isArray(m.content)) {
        const textParts = m.content
          .filter(
            (b: { type: string }) => b.type === "text" || b.type === "text_url",
          )
          .map((b: { type: string; text?: string }) => b.text ?? "")
          .join("\n");
        return { ...m, content: textParts || "[image]" };
      }
      return m;
    });
  fs.writeFileSync(tmpPath, JSON.stringify(toSave));
  fs.renameSync(tmpPath, filePath);
}

function generateSessionId(): string {
  return `crm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// System prompt construction
// ---------------------------------------------------------------------------

function buildOrgContext(persona: Persona): string {
  const lines: string[] = ["## Tu Equipo"];

  // Who I report to
  if (persona.reporta_a) {
    const boss = getPersonById(persona.reporta_a);
    if (boss) {
      lines.push(`Reportas a: *${boss.nombre}* (${boss.rol})`);
      // Boss's boss (for full chain visibility)
      if (boss.reporta_a) {
        const grandBoss = getPersonById(boss.reporta_a);
        if (grandBoss)
          lines.push(
            `  └ quien reporta a: *${grandBoss.nombre}* (${grandBoss.rol})`,
          );
      }
    }
  } else {
    lines.push("Eres el nivel mas alto de la jerarquia.");
  }

  // Direct reports — full tree so VP/director can see the complete org
  const directReports = getDirectReports(persona.id);
  if (directReports.length > 0) {
    lines.push("");
    lines.push("Reportes directos:");
    for (const dr of directReports) {
      const subReports = getDirectReports(dr.id);
      if (subReports.length > 0) {
        lines.push(`• *${dr.nombre}* (${dr.rol})`);
        for (const sub of subReports) {
          const leafReports = getDirectReports(sub.id);
          if (leafReports.length > 0) {
            lines.push(
              `  └ *${sub.nombre}* (${sub.rol}) → ${leafReports.map((l) => l.nombre).join(", ")}`,
            );
          } else {
            lines.push(`  └ *${sub.nombre}* (${sub.rol})`);
          }
        }
      } else {
        lines.push(`• *${dr.nombre}* (${dr.rol})`);
      }
    }
  }

  // Peers (same manager)
  if (persona.reporta_a) {
    const peers = getDirectReports(persona.reporta_a).filter(
      (p) => p.id !== persona.id,
    );
    if (peers.length > 0) {
      lines.push("");
      lines.push(
        `Pares (mismo jefe): ${peers.map((p) => `*${p.nombre}* (${p.rol})`).join(", ")}`,
      );
    }
  }

  return lines.join("\n");
}

/** Get current date/time string in Mexico City timezone. */
function getMxDateTime(): string {
  const now = new Date();
  const mxDate = now.toLocaleDateString("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const mxTime = now.toLocaleTimeString("es-MX", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return `${mxDate}, ${mxTime} (Ciudad de Mexico)`;
}

/** Refresh the date in the system message (replaces the Fecha y Hora section). */
function refreshSystemDate(messages: ChatMessage[]): void {
  const sys = messages[0];
  if (sys?.role === "system" && typeof sys.content === "string") {
    messages[0] = {
      role: "system",
      content: sys.content.replace(
        /## Fecha y Hora Actual\n.+/,
        `## Fecha y Hora Actual\n${getMxDateTime()}`,
      ),
    };
  }
}

function buildSystemPrompt(groupFolder: string, persona: Persona): string {
  const parts: string[] = [];

  // Global CLAUDE.md
  const globalPath = "/workspace/global/CLAUDE.md";
  if (fs.existsSync(globalPath)) {
    parts.push(fs.readFileSync(globalPath, "utf-8"));
  }

  // Per-group CLAUDE.md
  const groupPath = "/workspace/group/CLAUDE.md";
  if (fs.existsSync(groupPath)) {
    parts.push(fs.readFileSync(groupPath, "utf-8"));
  }

  // Date/time — refreshed on every inference call via refreshSystemDate()
  parts.push(`\n## Fecha y Hora Actual\n${getMxDateTime()}`);

  // Identity injection
  parts.push(
    `\n## Tu Identidad\nNombre: ${persona.nombre}\nRol: ${persona.rol}\nGrupo: ${groupFolder}`,
  );

  // Org tree injection
  parts.push(buildOrgContext(persona));

  // User profile injection (structured profile from perfil_usuario table)
  try {
    const db = getDatabase();
    const profile = getUserProfile(db, persona.id);
    if (profile) {
      const section = formatProfileSection(profile);
      if (section) parts.push(section);
    }
  } catch {
    // Profile not available — non-fatal, skip silently
  }

  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Context window management
// ---------------------------------------------------------------------------

function truncateMessages(
  messages: ChatMessage[],
  maxMessages: number,
): ChatMessage[] {
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  const rest = messages[0]?.role === "system" ? messages.slice(1) : messages;

  // Phase 1: trim by message count
  let kept = rest.length > maxMessages ? rest.slice(-maxMessages) : [...rest];

  // Phase 2: trim by total character count (prevents prompt bloat)
  // Count ALL payload: content strings + tool_call arguments + tool results
  const messageChars = (m: ChatMessage): number => {
    let chars = typeof m.content === "string" ? m.content.length : 0;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += (tc.function?.arguments ?? "").length;
      }
    }
    return chars;
  };
  let totalChars = kept.reduce((sum, m) => sum + messageChars(m), 0);
  while (kept.length > 2 && totalChars > MAX_SESSION_CHARS) {
    const dropped = kept.shift()!;
    totalChars -= messageChars(dropped);
  }

  // Drop orphaned tool results at the start
  while (kept.length > 0 && kept[0].role === "tool") {
    kept.shift();
  }
  return [...system, ...kept];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync("/tmp/input.json");
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: "error",
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Set inference env vars from secrets
  if (containerInput.secrets) {
    for (const [key, value] of Object.entries(containerInput.secrets)) {
      if (
        key.startsWith("INFERENCE_") ||
        key.startsWith("HINDSIGHT_") ||
        key.startsWith("GOOGLE_") ||
        key === "BRAVE_SEARCH_API_KEY" ||
        key === "BITLY_API_TOKEN"
      ) {
        process.env[key] = value;
      }
    }
  }

  // Validate inference config
  if (!process.env.INFERENCE_PRIMARY_MODEL) {
    writeOutput({
      status: "error",
      result: null,
      error:
        "Missing INFERENCE_PRIMARY_MODEL. Configure inference provider in .env.",
    });
    process.exit(1);
  }

  // Initialize database
  try {
    getDatabase();
    bootstrapCrm();
  } catch (err) {
    log(
      `Database init warning: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Identify persona
  const persona = getPersonByGroupFolder(containerInput.groupFolder);
  if (!persona) {
    writeOutput({
      status: "error",
      result: null,
      error: `Unknown persona for group folder: ${containerInput.groupFolder}`,
    });
    process.exit(1);
  }

  log(`Identified persona: ${persona.nombre} (${persona.rol})`);

  // Build tool context
  const toolCtx = buildToolContext(persona.id);
  if (!toolCtx) {
    writeOutput({
      status: "error",
      result: null,
      error: `Failed to build tool context for persona: ${persona.id}`,
    });
    process.exit(1);
  }

  // Get tools for role
  const tools = getToolsForRole(persona.rol);

  // Build system prompt
  const systemPrompt = buildSystemPrompt(containerInput.groupFolder, persona);

  // Tool executor: wraps executeTool with ToolContext + timeout
  const TOOL_TIMEOUT_MS = 15_000;
  const executor = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    return Promise.race([
      executeTool(name, args, toolCtx),
      new Promise<string>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`Tool "${name}" timed out after ${TOOL_TIMEOUT_MS}ms`),
            ),
          TOOL_TIMEOUT_MS,
        ),
      ),
    ]);
  };

  // Load or create session
  let sessionId = containerInput.sessionId || generateSessionId();
  let messages: ChatMessage[] = [];

  if (containerInput.sessionId) {
    const loaded = loadSession(containerInput.sessionId);
    if (loaded) {
      messages = loaded;
      log(`Resumed session ${sessionId} with ${messages.length} messages`);
    }
  }

  // Always set/refresh system message (persona may have changed since last session)
  if (messages.length > 0 && messages[0].role === "system") {
    messages[0] = { role: "system", content: systemPrompt };
  } else {
    messages.unshift({ role: "system", content: systemPrompt });
  }

  // Clean up stale IPC
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt — strip @CRM trigger to prevent LLM from mirroring it as a prefix
  let prompt = containerInput.prompt.replace(/@CRM\s*/gi, "").trim();
  if (containerInput.isScheduledTask) {
    prompt = `[TAREA PROGRAMADA - Este mensaje fue enviado automaticamente.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += "\n" + pending.join("\n");
  }

  // Build multimodal content from image references in text.
  // Works for both initial stdin input AND IPC follow-up messages.
  // Detects [Image: attachments/...] patterns, loads files from disk,
  // and builds OpenAI vision-format content blocks.
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

  const IMAGE_REF_PATTERN = /\[Image: (attachments\/[^\]]+)\]/g;

  // Track whether stdin attachments have been consumed (first message only)
  let stdinAttachmentsConsumed = false;

  function buildMultimodalContent(text: string): string | ContentBlock[] {
    // Collect image references from text
    const imageRefs: string[] = [];
    let match: RegExpExecArray | null;
    IMAGE_REF_PATTERN.lastIndex = 0;
    while ((match = IMAGE_REF_PATTERN.exec(text)) !== null) {
      imageRefs.push(match[1]);
    }

    // Also include explicit attachments from stdin (first call only)
    if (!stdinAttachmentsConsumed && containerInput.imageAttachments) {
      stdinAttachmentsConsumed = true;
      for (const img of containerInput.imageAttachments) {
        if (!imageRefs.includes(img.relativePath)) {
          imageRefs.push(img.relativePath);
        }
      }
    }

    if (imageRefs.length === 0) return text;

    // Strip [Image: ...] references from text — the actual image data
    // will be in the multimodal blocks. Leaving text references causes
    // non-vision models to hallucinate image descriptions.
    const cleanText = text.replace(IMAGE_REF_PATTERN, "").trim();

    const blocks: ContentBlock[] = [];
    if (cleanText) {
      blocks.push({ type: "text", text: cleanText });
    }

    for (const relativePath of imageRefs) {
      const imgPath = path.join("/workspace/group", relativePath);
      try {
        const data = fs.readFileSync(imgPath).toString("base64");
        blocks.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${data}` },
        });
        log(
          `Attached image: ${relativePath} (${Math.round((data.length * 0.75) / 1024)}kB)`,
        );
      } catch (err) {
        log(
          `Failed to read image ${imgPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Add text fallback so the LLM knows an image was intended but unavailable
        blocks.push({
          type: "text",
          text: `[No se pudo cargar la imagen: ${relativePath}]`,
        });
      }
    }

    return blocks.length > 0 ? blocks : text;
  }

  // Block streaming: accumulate full response, then emit the first block early
  // while the rest is still generating. Max 3 blocks, split at paragraph boundaries.
  const MAX_BLOCKS = 3;
  const FIRST_BLOCK_MIN = 300; // emit first block after ~300 chars to reduce perceived latency
  let streamBuffer = "";
  let firstBlockSent = false;

  const FIRST_BLOCK_FALLBACK = 600; // fallback to sentence break if no paragraph break by this point

  function emitFirstBlock(): void {
    if (firstBlockSent || streamBuffer.length < FIRST_BLOCK_MIN) return;
    // Find a clean paragraph break near or after FIRST_BLOCK_MIN
    const searchFrom = FIRST_BLOCK_MIN - 50;
    const breakIdx = streamBuffer.indexOf("\n\n", searchFrom);
    let cutIdx = breakIdx;
    let cutLen = 2; // length of the delimiter to skip

    // Fallback: if no paragraph break found and buffer is long enough,
    // cut at the last sentence boundary to avoid holding the entire response.
    if (cutIdx === -1 && streamBuffer.length >= FIRST_BLOCK_FALLBACK) {
      const sentenceRe = /[.!?]\s/g;
      let lastMatch = -1;
      let m: RegExpExecArray | null;
      while ((m = sentenceRe.exec(streamBuffer)) !== null) {
        if (m.index >= searchFrom) lastMatch = m.index;
      }
      if (lastMatch !== -1) {
        cutIdx = lastMatch + 1; // include the punctuation
        cutLen = 1; // skip only the trailing space
      }
    }

    if (cutIdx === -1) return; // still no suitable break
    const block = streamBuffer.slice(0, cutIdx).trim();
    streamBuffer = streamBuffer.slice(cutIdx + cutLen);
    firstBlockSent = true;
    if (block) {
      writeOutput({
        status: "success",
        result: block,
        newSessionId: sessionId,
        streaming: true,
      });
    }
  }

  function onTextChunk(delta: string): void {
    streamBuffer += delta;
    if (!firstBlockSent) emitFirstBlock();
  }

  /** Split remaining text into up to N blocks at paragraph boundaries. */
  function splitIntoBlocks(text: string, maxBlocks: number): string[] {
    const trimmed = text.trim();
    if (!trimmed || maxBlocks <= 1) return trimmed ? [trimmed] : [];

    const paragraphs = trimmed.split(/\n\n+/);
    if (paragraphs.length <= maxBlocks) {
      // Few paragraphs — send each as its own block
      return paragraphs.map((p) => p.trim()).filter(Boolean);
    }

    // Distribute paragraphs evenly across blocks
    const blocks: string[] = [];
    const perBlock = Math.ceil(paragraphs.length / maxBlocks);
    for (let i = 0; i < paragraphs.length; i += perBlock) {
      const chunk = paragraphs
        .slice(i, i + perBlock)
        .join("\n\n")
        .trim();
      if (chunk) blocks.push(chunk);
    }
    return blocks;
  }

  // Message loop — buildMultimodalContent handles image detection for ALL messages
  try {
    while (true) {
      messages.push({
        role: "user",
        content: buildMultimodalContent(prompt),
      });

      // Truncate for context window
      messages = truncateMessages(messages, MAX_MESSAGES);

      // Refresh date/time in system prompt (container may span midnight)
      refreshSystemDate(messages);

      log(
        `Starting inference (session: ${sessionId}, messages: ${messages.length})...`,
      );

      // Emit instant acknowledgment before inference (no LLM tokens spent).
      // Skip for scheduled tasks — no human is waiting for a reply.
      // streaming: true prevents the engine from calling queue.notifyIdle prematurely.
      if (!containerInput.isScheduledTask) {
        writeOutput({
          status: "success",
          result: ACK_MESSAGE,
          newSessionId: sessionId,
          streaming: true,
        });
      }

      // Call inference with tools (streaming text deltas via onTextChunk)
      firstBlockSent = false;
      streamBuffer = "";
      const result = await inferWithTools(
        messages,
        tools,
        executor,
        MAX_TOOL_ROUNDS,
        onTextChunk,
      );

      // Update messages with full conversation from inference
      messages = result.messages;

      // Emit remaining text as blocks (max MAX_BLOCKS total, minus 1 if first block was sent)
      const remainingSlots = firstBlockSent ? MAX_BLOCKS - 1 : MAX_BLOCKS;
      const remaining = streamBuffer.trim();

      if (remaining) {
        const blocks = splitIntoBlocks(remaining, remainingSlots);
        for (const block of blocks) {
          writeOutput({
            status: "success",
            result: block,
            newSessionId: sessionId,
            streaming: true,
          });
        }
        // Completion marker
        writeOutput({
          status: "success",
          result: null,
          newSessionId: sessionId,
        });
      } else if (firstBlockSent) {
        // First block was sent during streaming, no remaining text
        writeOutput({
          status: "success",
          result: null,
          newSessionId: sessionId,
        });
      } else if (result.content) {
        // No streaming happened (short response) — send as single message
        writeOutput({
          status: "success",
          result: result.content,
          newSessionId: sessionId,
        });
      } else {
        // Empty response: model returned no text and no tool calls.
        // Typically caused by output token limit exceeded (e.g. large tool
        // call argument) or context window overflow. Send user-facing error
        // instead of silence.
        log("Empty inference response — emitting fallback message");
        writeOutput({
          status: "success",
          result:
            "No pude procesar esa solicitud. Intenta reformularla o dividirla en partes más pequeñas.",
          newSessionId: sessionId,
        });

        // Remove the empty assistant message from conversation to prevent
        // session poisoning — empty responses compound into repeated failures.
        const lastMsg = messages[messages.length - 1];
        if (
          lastMsg?.role === "assistant" &&
          !lastMsg.content &&
          !lastMsg.tool_calls?.length
        ) {
          messages.pop();
          log("Removed empty assistant message from session history");
        }

        // Also remove the user message that triggered the empty response.
        // Leaving it creates consecutive user messages on the next turn,
        // which confuses models and compounds failures.
        const lastAfterPop = messages[messages.length - 1];
        if (lastAfterPop?.role === "user") {
          messages.pop();
          log(
            "Removed triggering user message to prevent consecutive user messages",
          );
        }
      }
      streamBuffer = "";

      // Save session
      saveSession(sessionId, messages);

      log(
        `Inference done. Usage: ${result.totalUsage.prompt_tokens}p/${result.totalUsage.completion_tokens}c`,
      );

      // Check for close during inference (non-blocking)
      if (shouldClose()) {
        log("Close sentinel received after inference, exiting");
        break;
      }

      // Wait for next IPC message or close
      log("Waiting for next IPC message...");
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log("Close sentinel received, exiting");
        break;
      }

      log(`Got new message (${nextMessage.length} chars), continuing`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: "error",
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();

// Exports for testing
export {
  buildOrgContext,
  buildSystemPrompt,
  truncateMessages,
  loadSession,
  saveSession,
  generateSessionId,
  drainIpcInput,
  shouldClose,
  writeOutput,
  stripCJK,
  readStdin,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  SESSIONS_DIR,
  MAX_MESSAGES,
  MAX_TOOL_ROUNDS,
  IPC_INPUT_DIR,
  IPC_INPUT_CLOSE_SENTINEL,
  IPC_POLL_MIN_MS,
  IPC_POLL_MAX_MS,
  getMxDateTime,
  refreshSystemDate,
};
export type { ContainerInput, ContainerOutput };
