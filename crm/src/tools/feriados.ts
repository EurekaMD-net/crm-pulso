/**
 * Public Holidays Tool — Nager.Date API (free, no auth)
 *
 * 90+ countries. Useful for campaign planning and scheduling.
 */

import type { ToolContext } from "./index.js";
import { getMxYear } from "./helpers.js";

const API_URL = "https://date.nager.at/api/v3";

export async function consultar_feriados(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<string> {
  const pais = ((args.pais as string) || "MX").toUpperCase();
  const soloProximos = (args.solo_proximos as boolean) ?? false;
  const año = (args.año as number) || getMxYear();

  const url = soloProximos
    ? `${API_URL}/NextPublicHolidays/${pais}`
    : `${API_URL}/PublicHolidays/${año}/${pais}`;

  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(fetchTimeout);
    if (err.name === "AbortError")
      return JSON.stringify({ error: "Nager.Date timeout (10s)" });
    return JSON.stringify({
      error: `Nager.Date error: ${err.message?.slice(0, 200) ?? "unknown"}`,
    });
  } finally {
    clearTimeout(fetchTimeout);
  }

  if (!response.ok) {
    return JSON.stringify({
      error: `Nager.Date API error: ${response.status}`,
    });
  }

  const data = (await response.json()) as NagerHoliday[];

  const feriados = data.map((h) => ({
    fecha: h.date,
    nombre_local: h.localName,
    nombre: h.name,
    tipo: h.types?.join(", ") ?? "Public",
  }));

  return JSON.stringify({ pais, feriados, total: feriados.length });
}

interface NagerHoliday {
  date: string;
  localName: string;
  name: string;
  types?: string[];
}
