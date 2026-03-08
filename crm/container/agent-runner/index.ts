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

import fs from 'fs';
import path from 'path';
import { bootstrapCrm } from '../../src/bootstrap.js';
import { getDatabase } from '../../../engine/src/db.js';
import { getPersonByGroupFolder, getPersonById, getDirectReports, getManager } from '../../src/hierarchy.js';
import type { Persona } from '../../src/hierarchy.js';
import { buildToolContext, executeTool, getToolsForRole } from '../../src/tools/index.js';
import { inferWithTools } from '../../src/inference-adapter.js';
import type { ChatMessage, ToolDefinition } from '../../src/inference-adapter.js';
import type { ToolContext } from '../../src/tools/index.js';

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
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MIN_MS = 100;
const IPC_POLL_MAX_MS = 500;
const MAX_MESSAGES = 12;
const MAX_TOOL_ROUNDS = 8;
const SESSIONS_DIR = '/workspace/group/.crm-sessions';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Pre-written acknowledgment phrases — picked at random, no LLM tokens wasted
const ACK_PHRASES = [
  'Entendido, lo consulto.',
  'Revisando, un momento.',
  'Lo verifico de inmediato.',
  'Consultando los datos.',
  'Preparando la información.',
  'Lo tengo, revisando.',
  'En ello, un momento.',
  'Listo, lo proceso.',
  'Dame un momento.',
  'Ya lo reviso.',
];
let ackIndex = Math.floor(Math.random() * ACK_PHRASES.length);

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.error(`[crm-agent-runner] ${message}`);
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
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
        resolve(messages.join('\n'));
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
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    log(`Failed to load session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function saveSession(sessionId: string, messages: ChatMessage[]): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  const tmpPath = filePath + '.tmp';
  // Don't persist system prompt — it's rebuilt from templates on load
  const toSave = messages.filter(m => m.role !== 'system');
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
  const lines: string[] = ['## Tu Equipo'];

  // Who I report to
  if (persona.reporta_a) {
    const boss = getPersonById(persona.reporta_a);
    if (boss) {
      lines.push(`Reportas a: *${boss.nombre}* (${boss.rol})`);
      // Boss's boss (for full chain visibility)
      if (boss.reporta_a) {
        const grandBoss = getPersonById(boss.reporta_a);
        if (grandBoss) lines.push(`  └ quien reporta a: *${grandBoss.nombre}* (${grandBoss.rol})`);
      }
    }
  } else {
    lines.push('Eres el nivel mas alto de la jerarquia.');
  }

  // Direct reports
  const directReports = getDirectReports(persona.id);
  if (directReports.length > 0) {
    lines.push('');
    lines.push('Reportes directos:');
    for (const dr of directReports) {
      // Sub-reports (e.g. director sees gerente's AEs)
      const subReports = getDirectReports(dr.id);
      if (subReports.length > 0) {
        lines.push(`• *${dr.nombre}* (${dr.rol}) — equipo: ${subReports.map(s => s.nombre).join(', ')}`);
      } else {
        lines.push(`• *${dr.nombre}* (${dr.rol})`);
      }
    }
  }

  // Peers (same manager)
  if (persona.reporta_a) {
    const peers = getDirectReports(persona.reporta_a).filter(p => p.id !== persona.id);
    if (peers.length > 0) {
      lines.push('');
      lines.push(`Pares (mismo jefe): ${peers.map(p => `*${p.nombre}* (${p.rol})`).join(', ')}`);
    }
  }

  return lines.join('\n');
}

function buildSystemPrompt(groupFolder: string, persona: Persona): string {
  const parts: string[] = [];

  // Global CLAUDE.md
  const globalPath = '/workspace/global/CLAUDE.md';
  if (fs.existsSync(globalPath)) {
    parts.push(fs.readFileSync(globalPath, 'utf-8'));
  }

  // Per-group CLAUDE.md
  const groupPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupPath)) {
    parts.push(fs.readFileSync(groupPath, 'utf-8'));
  }

  // Identity injection
  parts.push(`\n## Tu Identidad\nNombre: ${persona.nombre}\nRol: ${persona.rol}\nGrupo: ${groupFolder}`);

  // Org tree injection
  parts.push(buildOrgContext(persona));

  return parts.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Context window management
// ---------------------------------------------------------------------------

function truncateMessages(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  // Always keep system message (first) + last N user/assistant exchanges
  if (messages.length <= maxMessages + 1) return messages;

  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const rest = messages[0]?.role === 'system' ? messages.slice(1) : messages;
  // Keep only the last N messages, but ensure we don't break tool call pairs
  // (an assistant with tool_calls must be followed by tool results)
  let kept = rest.slice(-maxMessages);
  // If first kept message is a tool result, drop orphaned tool messages
  while (kept.length > 0 && kept[0].role === 'tool') {
    kept = kept.slice(1);
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
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Set inference env vars from secrets
  if (containerInput.secrets) {
    for (const [key, value] of Object.entries(containerInput.secrets)) {
      if (key.startsWith('INFERENCE_') || key === 'BRAVE_SEARCH_API_KEY') {
        process.env[key] = value;
      }
    }
  }

  // Validate inference config
  if (!process.env.INFERENCE_PRIMARY_MODEL) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'Missing INFERENCE_PRIMARY_MODEL. Configure inference provider in .env.',
    });
    process.exit(1);
  }

  // Initialize database
  try {
    getDatabase();
    bootstrapCrm();
  } catch (err) {
    log(`Database init warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Identify persona
  const persona = getPersonByGroupFolder(containerInput.groupFolder);
  if (!persona) {
    writeOutput({
      status: 'error',
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
      status: 'error',
      result: null,
      error: `Failed to build tool context for persona: ${persona.id}`,
    });
    process.exit(1);
  }

  // Get tools for role
  const tools = getToolsForRole(persona.rol);

  // Build system prompt
  const systemPrompt = buildSystemPrompt(
    containerInput.groupFolder,
    persona,
  );

  // Tool executor: wraps executeTool with ToolContext + timeout
  const TOOL_TIMEOUT_MS = 15_000;
  const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
    return Promise.race([
      executeTool(name, args, toolCtx),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS),
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
  if (messages.length > 0 && messages[0].role === 'system') {
    messages[0] = { role: 'system', content: systemPrompt };
  } else {
    messages.unshift({ role: 'system', content: systemPrompt });
  }

  // Clean up stale IPC
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[TAREA PROGRAMADA - Este mensaje fue enviado automaticamente.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Note: image attachments are referenced in the prompt as [Image: attachments/...]
  // Qwen 3.5 (text model) cannot process image_url content blocks, so we pass
  // the text reference only. The agent can acknowledge the image was received.

  // Message loop
  try {
    while (true) {
      messages.push({ role: 'user', content: prompt });

      // Truncate for context window
      messages = truncateMessages(messages, MAX_MESSAGES);

      log(`Starting inference (session: ${sessionId}, messages: ${messages.length})...`);

      // Emit instant acknowledgment before inference (no LLM tokens spent)
      const ack = ACK_PHRASES[ackIndex % ACK_PHRASES.length];
      ackIndex++;
      writeOutput({ status: 'success', result: ack, newSessionId: sessionId });

      // Call inference with tools
      const result = await inferWithTools(messages, tools, executor, MAX_TOOL_ROUNDS);

      // Update messages with full conversation from inference
      messages = result.messages;

      // Write output
      writeOutput({
        status: 'success',
        result: result.content,
        newSessionId: sessionId,
      });

      // Save session
      saveSession(sessionId, messages);

      log(`Inference done. Usage: ${result.totalUsage.prompt_tokens}p/${result.totalUsage.completion_tokens}c`);

      // Check for close during inference (non-blocking)
      if (shouldClose()) {
        log('Close sentinel received after inference, exiting');
        break;
      }

      // Wait for next IPC message or close
      log('Waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), continuing`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
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
};
export type { ContainerInput, ContainerOutput };
