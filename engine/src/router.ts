import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function compactMessages(
  messages: NewMessage[],
  maxMessages: number,
): { messages: NewMessage[]; truncatedCount: number } {
  if (messages.length <= maxMessages) {
    return { messages, truncatedCount: 0 };
  }
  return {
    messages: messages.slice(-maxMessages),
    truncatedCount: messages.length - maxMessages,
  };
}

export function formatMessages(
  messages: NewMessage[],
  truncatedCount?: number,
): string {
  const lines = messages.map(
    (m) =>
      `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  const header =
    truncatedCount && truncatedCount > 0
      ? `<context-note>${truncatedCount} older messages were truncated. Check the group's CLAUDE.md and conversations/ folder for historical context.</context-note>\n`
      : '';
  return `<messages>\n${header}${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
