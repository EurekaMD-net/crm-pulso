/**
 * Web Search Tool — Brave Search API
 */

import type { ToolContext } from './index.js';

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';

export async function buscar_web(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
  const query = args.query as string;
  if (!query) return JSON.stringify({ error: 'Se requiere el parámetro "query"' });
  const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY || '';
  if (!BRAVE_API_KEY) return JSON.stringify({ error: 'BRAVE_SEARCH_API_KEY no configurada' });

  const limit = Math.min((args.limite as number) || 5, 10);
  const url = `${BRAVE_URL}?q=${encodeURIComponent(query)}&count=${limit}`;

  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(fetchTimeout);
    if (err.name === 'AbortError') return JSON.stringify({ error: 'Brave Search timeout (10s)' });
    return JSON.stringify({ error: `Brave Search error: ${err.message?.slice(0, 200) ?? 'unknown'}` });
  } finally {
    clearTimeout(fetchTimeout);
  }

  if (!response.ok) {
    return JSON.stringify({ error: `Brave API error: ${response.status}` });
  }

  const data = await response.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
  const results = (data.web?.results || []).map(r => ({
    titulo: r.title,
    url: r.url,
    descripcion: r.description,
  }));

  return JSON.stringify({ resultados: results, total: results.length });
}
