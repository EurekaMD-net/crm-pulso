/**
 * RAG Search Tool
 *
 * buscar_documentos — semantic search over synced documents
 * Hierarchy-scoped: AE sees own docs, gerente sees team, director/VP sees org.
 */

import { searchDocuments } from '../doc-sync.js';
import type { ToolContext } from './index.js';

export async function buscar_documentos(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const consulta = args.consulta as string;
  if (!consulta || typeof consulta !== 'string') {
    return JSON.stringify({ error: 'Se requiere el parametro "consulta".' });
  }

  const limite = Math.min(Math.max(Number(args.limite) || 5, 1), 20);
  const tipoDoc = typeof args.tipo_doc === 'string' ? args.tipo_doc : undefined;

  // Build hierarchy-scoped persona IDs
  let personaIds: string[];
  if (ctx.rol === 'vp') {
    // VP: full org visibility — empty array means no filter
    personaIds = [];
  } else if (ctx.rol === 'director') {
    personaIds = [ctx.persona_id, ...ctx.full_team_ids];
  } else if (ctx.rol === 'gerente') {
    personaIds = [ctx.persona_id, ...ctx.team_ids];
  } else {
    // AE: own docs only
    personaIds = [ctx.persona_id];
  }

  const results = await searchDocuments(consulta, personaIds, limite, tipoDoc);

  if (results.length === 0) {
    return JSON.stringify({ mensaje: 'No se encontraron documentos relevantes.', resultados: [] });
  }

  return JSON.stringify({
    resultados: results.map(r => ({
      titulo: r.titulo,
      fragmento: r.fragmento,
      similitud: Math.round(r.similitud * 100) / 100,
      persona_id: r.persona_id,
    })),
  });
}
