#!/usr/bin/env tsx
/**
 * Daily Activity Seeder
 *
 * Generates realistic daily activities for every active AE from their last
 * activity date up to today. Designed to run daily (cron, startup, or manual)
 * to keep the demo database alive with fresh data.
 *
 * Work week: Mon-Fri, 9am-8pm Mexico City. Occasional weekend/late events (~8%).
 * Each AE gets 2-5 activities per workday, 0-1 on weekends.
 *
 * Idempotent: uses date-based IDs so re-runs don't duplicate.
 *
 * Usage:
 *   npx tsx scripts/seed-daily.ts           # fill gaps up to today
 *   npx tsx scripts/seed-daily.ts --dry-run # show what would be inserted
 */

import { getDatabase } from "../crm/src/db.js";

const db = getDatabase();
const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEZONE_OFFSET_HOURS = -6; // America/Mexico_City (CST, no DST for simplicity)

const aeRows = db
  .prepare(
    `
  SELECT p.id, p.nombre, c.id AS cuenta_id, c.nombre AS cuenta_nombre
  FROM persona p
  LEFT JOIN cuenta c ON c.ae_id = p.id
  WHERE p.rol = 'ae' AND p.activo = 1
  ORDER BY p.id
`,
  )
  .all() as {
  id: string;
  nombre: string;
  cuenta_id: string;
  cuenta_nombre: string;
}[];

// Activity types with realistic weekday weights
const ACTIVITY_POOL: { tipo: string; weight: number; resumenes: string[] }[] = [
  {
    tipo: "llamada",
    weight: 25,
    resumenes: [
      "Llamada de seguimiento sobre la propuesta. El cliente pedirá aprobación esta semana.",
      "Llamada para confirmar el brief. Quedó de mandarme los assets.",
      "Llamé para checar status del presupuesto. Me dicen que sigue en aprobación.",
      "Call con el equipo de compras para negociar tarifas de CTV.",
      "Hablé con el contacto para explorar oportunidad de radio para Q2.",
      "Llamada para agradecer la orden y alinear próximos pasos de ejecución.",
      "Llamé para dar seguimiento a la factura pendiente.",
    ],
  },
  {
    tipo: "whatsapp",
    weight: 30,
    resumenes: [
      "Me escribió preguntando por disponibilidad de spots en prime time.",
      "Le mandé resumen de la reunión de ayer. Confirmó que va bien.",
      "Me pidió por WhatsApp cotización actualizada para digital.",
      "Mensaje rápido para confirmar la reunión de mañana.",
      "Me compartió el brief nuevo por WhatsApp. Lo reviso hoy.",
      "Le envié los ratings del último flight. Le gustaron los números.",
      "Me preguntó si hay paquetes combo TV+digital. Le preparo opciones.",
      "Recibí confirmación verbal por WhatsApp. Falta la OC formal.",
    ],
  },
  {
    tipo: "email",
    weight: 20,
    resumenes: [
      "Envié cotización formal con desglose por medio y calendario de vuelos.",
      "Recibí feedback del cliente sobre la propuesta. Pide ajustar presupuesto.",
      "Email con minuta de la reunión y próximos pasos.",
      "Le mandé el caso de éxito de la última campaña como referencia.",
      "Recibí la OC firmada por email. La paso a facturación.",
      "Email de seguimiento post-presentación. Quedó de responder esta semana.",
    ],
  },
  {
    tipo: "reunion",
    weight: 12,
    resumenes: [
      "Presentación del plan de medios Q2. Buena recepción del equipo de marketing.",
      "Reunión de cierre con compras y marketing. Negociamos 5% de descuento.",
      "Junta de planeación para campaña de verano. Definimos mix de medios.",
      "Presenté los resultados de la campaña anterior. Impresionados con el reach.",
      "Reunión de kickoff para nueva campaña. Alineamos timelines y entregables.",
    ],
  },
  {
    tipo: "visita",
    weight: 5,
    resumenes: [
      "Visita al corporativo para entregar propuesta en persona.",
      "Fui a las oficinas del cliente para conocer al nuevo director de marketing.",
      "Visita de cortesía para fortalecer la relación. Hablamos del pipeline 2026.",
    ],
  },
  {
    tipo: "comida",
    weight: 4,
    resumenes: [
      "Comida con el director de marketing. Hablamos de planes para el segundo semestre.",
      "Comida de trabajo para revisar números de la campaña en curso.",
      "Almuerzo con el equipo del cliente para celebrar cierre de deal.",
    ],
  },
  {
    tipo: "envio_propuesta",
    weight: 4,
    resumenes: [
      "Envié la propuesta formal con desglose completo de TV, radio y digital.",
      "Mandé propuesta revisada con los ajustes que pidió el cliente.",
      "Envié propuesta de paquete especial para el tentpole de mayo.",
    ],
  },
];

const SENTIMIENTO_DIST = [
  "positivo",
  "positivo",
  "positivo",
  "positivo", // 40%
  "neutral",
  "neutral",
  "neutral", // 30%
  "negativo",
  "negativo", // 20%
  "urgente", // 10%
];

const SIGUIENTE_ACCIONES = [
  "Enviar cotización actualizada",
  "Agendar reunión de cierre",
  "Dar seguimiento a la OC",
  "Preparar presentación de resultados",
  "Mandar caso de éxito por email",
  "Llamar para confirmar disponibilidad",
  "Revisar propuesta con gerente antes de enviar",
  "Confirmar presupuesto aprobado",
  null,
  null,
  null,
  null,
  null, // ~38% have no next action
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random based on seed */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 49297;
  return x - Math.floor(x);
}

/** Pick from array using seed */
function pick<T>(arr: T[], seed: number): T {
  return arr[Math.floor(seededRandom(seed) * arr.length)];
}

/** Weighted random pick from activity pool */
function pickActivity(seed: number): { tipo: string; resumen: string } {
  const totalWeight = ACTIVITY_POOL.reduce((s, a) => s + a.weight, 0);
  let roll = seededRandom(seed) * totalWeight;
  for (const pool of ACTIVITY_POOL) {
    roll -= pool.weight;
    if (roll <= 0) {
      return {
        tipo: pool.tipo,
        resumen: pick(pool.resumenes, seed + 777),
      };
    }
  }
  const last = ACTIVITY_POOL[ACTIVITY_POOL.length - 1];
  return { tipo: last.tipo, resumen: pick(last.resumenes, seed) };
}

/** Generate a timestamp on a given date within working hours (9-20 MX time) */
function workingTimestamp(date: Date, seed: number): string {
  const hour = 9 + Math.floor(seededRandom(seed) * 11); // 9-19
  const minute = Math.floor(seededRandom(seed + 1) * 60);
  const d = new Date(date);
  // Set UTC hours to MX working hours + offset
  d.setUTCHours(hour - TIMEZONE_OFFSET_HOURS, minute, 0, 0);
  return d.toISOString();
}

/** Check if a date is a weekday (Mon=1 ... Fri=5) */
function isWeekday(date: Date): boolean {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

/** Get dates from startDate (exclusive) to endDate (inclusive) */
function dateRange(startDate: Date, endDate: Date): Date[] {
  const dates: Date[] = [];
  const current = new Date(startDate);
  current.setUTCDate(current.getUTCDate() + 1);
  current.setUTCHours(12, 0, 0, 0);

  while (current <= endDate) {
    dates.push(new Date(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/** Format date as YYYY-MM-DD for ID generation */
function dateId(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

const today = new Date();
today.setUTCHours(12, 0, 0, 0); // noon UTC = 6am MX, before work starts

const insertAct = db.prepare(`
  INSERT OR IGNORE INTO actividad
    (id, ae_id, cuenta_id, tipo, resumen, sentimiento, siguiente_accion, fecha_siguiente_accion, fecha)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let totalInserted = 0;
let totalSkipped = 0;

for (const ae of aeRows) {
  if (!ae.cuenta_id) continue;

  // Find latest activity for this AE
  const latest = db
    .prepare("SELECT MAX(fecha) as latest FROM actividad WHERE ae_id = ?")
    .get(ae.id) as { latest: string | null };

  let fromDate: Date;
  if (latest?.latest) {
    fromDate = new Date(latest.latest);
    fromDate.setUTCHours(12, 0, 0, 0); // normalize to day
  } else {
    // No activities at all — start from 4 weeks ago
    fromDate = new Date(today);
    fromDate.setUTCDate(fromDate.getUTCDate() - 28);
  }

  const days = dateRange(fromDate, today);
  if (days.length === 0) continue;

  let aeInserted = 0;

  for (const day of days) {
    const dayKey = dateId(day);
    const weekday = isWeekday(day);
    const baseSeed =
      parseInt(ae.id.replace(/\D/g, "")) * 10000 + parseInt(dayKey);

    // Determine how many activities for this day
    let actCount: number;
    if (weekday) {
      // Weekday: 2-5 activities (weighted toward 3-4)
      const r = seededRandom(baseSeed);
      if (r < 0.15) actCount = 2;
      else if (r < 0.5) actCount = 3;
      else if (r < 0.85) actCount = 4;
      else actCount = 5;
    } else {
      // Weekend: 8% chance of 1 activity (extraordinary event)
      actCount = seededRandom(baseSeed) < 0.08 ? 1 : 0;
    }

    for (let i = 0; i < actCount; i++) {
      const actSeed = baseSeed + i * 137;
      const actId = `daily-${ae.id}-${dayKey}-${i}`;

      // Check if already exists (fast path — INSERT OR IGNORE handles it too)
      const { tipo, resumen } = pickActivity(actSeed);
      const sentimiento = pick(SENTIMIENTO_DIST, actSeed + 42);
      const timestamp = workingTimestamp(day, actSeed + 99);

      // Next action (~62% of activities have one)
      const sigAccion = pick(SIGUIENTE_ACCIONES, actSeed + 200);
      let fechaSigAccion: string | null = null;
      if (sigAccion) {
        // 1-5 business days ahead
        const daysAhead = 1 + Math.floor(seededRandom(actSeed + 300) * 5);
        const futureDate = new Date(day);
        futureDate.setUTCDate(futureDate.getUTCDate() + daysAhead);
        // Skip to Monday if lands on weekend
        if (futureDate.getUTCDay() === 0)
          futureDate.setUTCDate(futureDate.getUTCDate() + 1);
        if (futureDate.getUTCDay() === 6)
          futureDate.setUTCDate(futureDate.getUTCDate() + 2);
        fechaSigAccion =
          futureDate.toISOString().slice(0, 10) + "T15:00:00.000Z";
      }

      if (DRY_RUN) {
        console.log(
          `  [DRY] ${actId} | ${ae.nombre} | ${tipo} | ${sentimiento} | ${timestamp.slice(0, 16)}`,
        );
        aeInserted++;
      } else {
        const result = insertAct.run(
          actId,
          ae.id,
          ae.cuenta_id,
          tipo,
          resumen,
          sentimiento,
          sigAccion,
          fechaSigAccion,
          timestamp,
        );
        if (result.changes > 0) aeInserted++;
        else totalSkipped++;
      }
    }
  }

  if (aeInserted > 0) {
    totalInserted += aeInserted;
    if (DRY_RUN) {
      console.log(
        `${ae.nombre}: ${aeInserted} activities (${days.length} days)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Also update proposal staleness (dias_sin_actividad) for active proposals
// ---------------------------------------------------------------------------

if (!DRY_RUN) {
  const updated = db
    .prepare(
      `
    UPDATE propuesta
    SET dias_sin_actividad = CAST(
      (julianday('now') - julianday(fecha_ultima_actividad)) AS INTEGER
    )
    WHERE etapa NOT IN ('completada', 'perdida', 'cancelada')
  `,
    )
    .run();

  console.log(`Updated ${updated.changes} proposal staleness counters`);
}

console.log(
  `\nDaily seed complete: ${totalInserted} activities inserted, ${totalSkipped} skipped (already existed)`,
);

if (!DRY_RUN) {
  // Show summary
  const summary = db
    .prepare(
      `
    SELECT ae_id, COUNT(*) as today_count
    FROM actividad
    WHERE fecha >= date('now', 'start of day')
    GROUP BY ae_id
    ORDER BY ae_id
  `,
    )
    .all() as { ae_id: string; today_count: number }[];

  if (summary.length > 0) {
    console.log(`\nToday's activity counts by AE:`);
    for (const s of summary) {
      const ae = aeRows.find((a) => a.id === s.ae_id);
      console.log(`  ${ae?.nombre || s.ae_id}: ${s.today_count}`);
    }
  }
}
