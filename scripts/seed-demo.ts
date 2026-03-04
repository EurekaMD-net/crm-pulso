#!/usr/bin/env tsx
/**
 * Seed Demo Data — Apex Medios
 *
 * Populates the CRM database with realistic demo data for a fictional
 * Mexican media company. Run with: npx tsx scripts/seed-demo.ts
 */

import { getDatabase } from '../crm/src/db.js';
import { createCrmSchema } from '../crm/src/schema.js';

// Initialize CRM DB (data/store/crm.db)
const db = getDatabase();
db.pragma('foreign_keys = ON');
createCrmSchema(db);

function id(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

const NOW = new Date().toISOString();
const YEAR = 2026;

// ===========================================================================
// 1. PERSONA — 28 people org chart
// ===========================================================================

interface PersonaSeed { id: string; nombre: string; rol: string; reporta_a: string | null; email: string; folder: string; }

const personas: PersonaSeed[] = [
  // VP
  { id: id('per', 1), nombre: 'Roberto Vega', rol: 'vp', reporta_a: null, email: 'rvega@apexmedios.com.mx', folder: 'vp-roberto-vega' },
  // Directors
  { id: id('per', 2), nombre: 'Ana Martínez', rol: 'director', reporta_a: id('per', 1), email: 'amartinez@apexmedios.com.mx', folder: 'dir-ana-martinez' },
  { id: id('per', 3), nombre: 'Luis Gutiérrez', rol: 'director', reporta_a: id('per', 1), email: 'lgutierrez@apexmedios.com.mx', folder: 'dir-luis-gutierrez' },
  // Gerentes under Ana
  { id: id('per', 4), nombre: 'Miguel Ríos', rol: 'gerente', reporta_a: id('per', 2), email: 'mrios@apexmedios.com.mx', folder: 'ger-miguel-rios' },
  { id: id('per', 5), nombre: 'Laura Sánchez', rol: 'gerente', reporta_a: id('per', 2), email: 'lsanchez@apexmedios.com.mx', folder: 'ger-laura-sanchez' },
  { id: id('per', 6), nombre: 'Fernando Castillo', rol: 'gerente', reporta_a: id('per', 2), email: 'fcastillo@apexmedios.com.mx', folder: 'ger-fernando-castillo' },
  // Gerentes under Luis
  { id: id('per', 7), nombre: 'Carmen Flores', rol: 'gerente', reporta_a: id('per', 3), email: 'cflores@apexmedios.com.mx', folder: 'ger-carmen-flores' },
  { id: id('per', 8), nombre: 'Ricardo Moreno', rol: 'gerente', reporta_a: id('per', 3), email: 'rmoreno@apexmedios.com.mx', folder: 'ger-ricardo-moreno' },
  // AEs under Miguel Ríos
  { id: id('per', 10), nombre: 'María López', rol: 'ae', reporta_a: id('per', 4), email: 'mlopez@apexmedios.com.mx', folder: 'ae-maria-lopez' },
  { id: id('per', 11), nombre: 'Carlos Hernández', rol: 'ae', reporta_a: id('per', 4), email: 'chernandez@apexmedios.com.mx', folder: 'ae-carlos-hernandez' },
  // AEs under Laura Sánchez
  { id: id('per', 12), nombre: 'José García', rol: 'ae', reporta_a: id('per', 5), email: 'jgarcia@apexmedios.com.mx', folder: 'ae-jose-garcia' },
  { id: id('per', 13), nombre: 'Diana Torres', rol: 'ae', reporta_a: id('per', 5), email: 'dtorres@apexmedios.com.mx', folder: 'ae-diana-torres' },
  { id: id('per', 14), nombre: 'Pedro Ramírez', rol: 'ae', reporta_a: id('per', 5), email: 'pramirez@apexmedios.com.mx', folder: 'ae-pedro-ramirez' },
  // AEs under Fernando Castillo
  { id: id('per', 15), nombre: 'Sofía Morales', rol: 'ae', reporta_a: id('per', 6), email: 'smorales@apexmedios.com.mx', folder: 'ae-sofia-morales' },
  { id: id('per', 16), nombre: 'Andrés Jiménez', rol: 'ae', reporta_a: id('per', 6), email: 'ajimenez@apexmedios.com.mx', folder: 'ae-andres-jimenez' },
  // AEs under Carmen Flores
  { id: id('per', 17), nombre: 'Valentina Cruz', rol: 'ae', reporta_a: id('per', 7), email: 'vcruz@apexmedios.com.mx', folder: 'ae-valentina-cruz' },
  { id: id('per', 18), nombre: 'Rodrigo Mendoza', rol: 'ae', reporta_a: id('per', 7), email: 'rmendoza@apexmedios.com.mx', folder: 'ae-rodrigo-mendoza' },
  { id: id('per', 19), nombre: 'Gabriela Ruiz', rol: 'ae', reporta_a: id('per', 7), email: 'gruiz@apexmedios.com.mx', folder: 'ae-gabriela-ruiz' },
  // AEs under Ricardo Moreno
  { id: id('per', 20), nombre: 'Daniel Herrera', rol: 'ae', reporta_a: id('per', 8), email: 'dherrera@apexmedios.com.mx', folder: 'ae-daniel-herrera' },
  { id: id('per', 21), nombre: 'Alejandra Vargas', rol: 'ae', reporta_a: id('per', 8), email: 'avargas@apexmedios.com.mx', folder: 'ae-alejandra-vargas' },
];

const insertPersona = db.prepare(`INSERT INTO persona (id, nombre, rol, reporta_a, whatsapp_group_folder, email, activo) VALUES (?, ?, ?, ?, ?, ?, 1)`);
for (const p of personas) {
  insertPersona.run(p.id, p.nombre, p.rol, p.reporta_a, p.folder, p.email);
}

// AE lookup by index (for assignments)
const aeIds = personas.filter(p => p.rol === 'ae').map(p => p.id);

// ===========================================================================
// 2. CUENTAS — 12 accounts
// ===========================================================================

interface CuentaSeed { id: string; nombre: string; tipo: string; vertical: string; ae_idx: number; años: number; fundador: number; }

const cuentas: CuentaSeed[] = [
  { id: id('cta', 1), nombre: 'Coca-Cola', tipo: 'directo', vertical: 'Bebidas', ae_idx: 0, años: 12, fundador: 1 },
  { id: id('cta', 2), nombre: 'Bimbo', tipo: 'directo', vertical: 'Alimentos', ae_idx: 1, años: 8, fundador: 1 },
  { id: id('cta', 3), nombre: 'P&G', tipo: 'agencia', vertical: 'Consumo', ae_idx: 2, años: 6, fundador: 0 },
  { id: id('cta', 4), nombre: 'Unilever', tipo: 'agencia', vertical: 'Consumo', ae_idx: 3, años: 5, fundador: 0 },
  { id: id('cta', 5), nombre: "L'Oréal", tipo: 'agencia', vertical: 'Belleza', ae_idx: 4, años: 3, fundador: 0 },
  { id: id('cta', 6), nombre: 'Telcel', tipo: 'directo', vertical: 'Telecomunicaciones', ae_idx: 5, años: 10, fundador: 1 },
  { id: id('cta', 7), nombre: 'Liverpool', tipo: 'directo', vertical: 'Retail', ae_idx: 6, años: 4, fundador: 0 },
  { id: id('cta', 8), nombre: 'Volkswagen', tipo: 'agencia', vertical: 'Automotriz', ae_idx: 7, años: 7, fundador: 0 },
  { id: id('cta', 9), nombre: 'Nestlé', tipo: 'agencia', vertical: 'Alimentos', ae_idx: 8, años: 9, fundador: 1 },
  { id: id('cta', 10), nombre: 'Colgate-Palmolive', tipo: 'agencia', vertical: 'Consumo', ae_idx: 9, años: 4, fundador: 0 },
  { id: id('cta', 11), nombre: 'BBVA', tipo: 'directo', vertical: 'Financiero', ae_idx: 10, años: 2, fundador: 0 },
  { id: id('cta', 12), nombre: 'Amazon México', tipo: 'directo', vertical: 'E-commerce', ae_idx: 11, años: 1, fundador: 0 },
];

const insertCuenta = db.prepare(`INSERT INTO cuenta (id, nombre, tipo, vertical, ae_id, años_relacion, es_fundador) VALUES (?, ?, ?, ?, ?, ?, ?)`);
for (const c of cuentas) {
  insertCuenta.run(c.id, c.nombre, c.tipo, c.vertical, aeIds[c.ae_idx % aeIds.length], c.años, c.fundador);
}

// ===========================================================================
// 3. CONTACTOS — 2 per account
// ===========================================================================

const contactoRoles = ['decisor', 'comprador', 'planeador', 'operativo'];
const insertContacto = db.prepare(`INSERT INTO contacto (id, nombre, cuenta_id, rol, seniority, email) VALUES (?, ?, ?, ?, ?, ?)`);

for (let i = 0; i < cuentas.length; i++) {
  insertContacto.run(id('con', i * 2 + 1), `Dir. Mktg ${cuentas[i].nombre}`, cuentas[i].id, 'decisor', 'director', `mktg@${cuentas[i].nombre.toLowerCase().replace(/[^a-z]/g, '')}.com`);
  insertContacto.run(id('con', i * 2 + 2), `Compras ${cuentas[i].nombre}`, cuentas[i].id, 'comprador', 'senior', `compras@${cuentas[i].nombre.toLowerCase().replace(/[^a-z]/g, '')}.com`);
}

// ===========================================================================
// 4. CONTRATOS — 8 annual upfronts for 2026
// ===========================================================================

const contratoMontos = [45_000_000, 32_000_000, 28_000_000, 22_000_000, 18_000_000, 40_000_000, 15_000_000, 35_000_000];
const insertContrato = db.prepare(`INSERT INTO contrato (id, cuenta_id, año, monto_comprometido, estatus) VALUES (?, ?, ?, ?, 'en_ejecucion')`);

for (let i = 0; i < 8; i++) {
  insertContrato.run(id('ctr', i + 1), cuentas[i].id, YEAR, contratoMontos[i]);
}

// ===========================================================================
// 5. DESCARGAS — 8 weeks × 8 accounts = 64 rows
// ===========================================================================

const insertDescarga = db.prepare(`INSERT INTO descarga (id, cuenta_id, contrato_id, semana, año, planificado, facturado, gap_acumulado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

for (let i = 0; i < 8; i++) {
  const weeklyPlan = contratoMontos[i] / 52;
  let gapAcum = 0;
  for (let w = 1; w <= 8; w++) {
    // Coca-Cola and Bimbo running ahead; Unilever and Nestlé behind
    let factor = 0.95 + Math.random() * 0.1; // 95-105%
    if (i === 0 || i === 1) factor = 1.02 + Math.random() * 0.05; // ahead
    if (i === 3 || i === 8) factor = 0.78 + Math.random() * 0.07; // behind 15-20%

    const planned = Math.round(weeklyPlan);
    const billed = Math.round(weeklyPlan * factor);
    gapAcum += (planned - billed);

    insertDescarga.run(id('desc', i * 8 + w), cuentas[i].id, id('ctr', i + 1), w, YEAR, planned, billed, Math.round(gapAcum));
  }
}

// ===========================================================================
// 6. PROPUESTAS — 25 spread across stages
// ===========================================================================

const propuestas = [
  // en_preparacion (3)
  { titulo: 'Campaña Día de las Madres Coca-Cola', cuenta_idx: 0, valor: 8_500_000, tipo: 'estacional', gancho: 'Día de las Madres', etapa: 'en_preparacion', dias: 2 },
  { titulo: 'Lanzamiento Producto Nestlé', cuenta_idx: 8, valor: 4_200_000, tipo: 'lanzamiento', gancho: null, etapa: 'en_preparacion', dias: 1 },
  { titulo: 'Reforzamiento Q2 Liverpool', cuenta_idx: 6, valor: 3_100_000, tipo: 'reforzamiento', gancho: null, etapa: 'en_preparacion', dias: 3 },
  // enviada (5) — 2 with >7 days no activity (trigger alerts)
  { titulo: 'Campaña Buen Fin Bimbo', cuenta_idx: 1, valor: 12_000_000, tipo: 'tentpole', gancho: 'Buen Fin', etapa: 'enviada', dias: 3 },
  { titulo: 'Digital Q2 P&G', cuenta_idx: 2, valor: 6_800_000, tipo: 'estacional', gancho: null, etapa: 'enviada', dias: 10 },
  { titulo: 'CTV Unilever Verano', cuenta_idx: 3, valor: 5_500_000, tipo: 'estacional', gancho: 'Verano', etapa: 'enviada', dias: 12 },
  { titulo: 'Radio L\'Oréal Primavera', cuenta_idx: 4, valor: 2_800_000, tipo: 'estacional', gancho: 'Primavera', etapa: 'enviada', dias: 4 },
  { titulo: 'Telcel Paquete Multimedios', cuenta_idx: 5, valor: 18_000_000, tipo: 'reforzamiento', gancho: null, etapa: 'enviada', dias: 2 },
  // en_discusion (6)
  { titulo: 'Coca-Cola Copa del Mundo', cuenta_idx: 0, valor: 22_000_000, tipo: 'evento_especial', gancho: 'Copa del Mundo', etapa: 'en_discusion', dias: 5 },
  { titulo: 'VW Lanzamiento SUV', cuenta_idx: 7, valor: 9_000_000, tipo: 'lanzamiento', gancho: null, etapa: 'en_discusion', dias: 6 },
  { titulo: 'BBVA Campaña Ahorro', cuenta_idx: 10, valor: 7_200_000, tipo: 'estacional', gancho: null, etapa: 'en_discusion', dias: 3 },
  { titulo: 'Amazon Prime Day', cuenta_idx: 11, valor: 11_000_000, tipo: 'tentpole', gancho: 'Prime Day', etapa: 'en_discusion', dias: 4 },
  { titulo: 'Colgate Regreso a Clases', cuenta_idx: 9, valor: 3_500_000, tipo: 'estacional', gancho: 'Regreso a Clases', etapa: 'en_discusion', dias: 8 },
  { titulo: 'Bimbo Tentpole Navidad', cuenta_idx: 1, valor: 15_500_000, tipo: 'tentpole', gancho: 'Navidad', etapa: 'en_discusion', dias: 2 },
  // en_negociacion (4)
  { titulo: 'P&G Paquete Anual Digital', cuenta_idx: 2, valor: 14_000_000, tipo: 'prospeccion', gancho: null, etapa: 'en_negociacion', dias: 3 },
  { titulo: 'Nestlé Radio Nacional', cuenta_idx: 8, valor: 6_000_000, tipo: 'reforzamiento', gancho: null, etapa: 'en_negociacion', dias: 5 },
  { titulo: 'Liverpool Hot Sale', cuenta_idx: 6, valor: 8_500_000, tipo: 'tentpole', gancho: 'Hot Sale', etapa: 'en_negociacion', dias: 1 },
  { titulo: 'Unilever CTV Annual', cuenta_idx: 3, valor: 10_000_000, tipo: 'prospeccion', gancho: null, etapa: 'en_negociacion', dias: 7 },
  // confirmada_verbal (2)
  { titulo: 'Telcel Paquete TV Nacional', cuenta_idx: 5, valor: 25_000_000, tipo: 'reforzamiento', gancho: null, etapa: 'confirmada_verbal', dias: 1 },
  { titulo: 'Coca-Cola Spots Deportes', cuenta_idx: 0, valor: 12_500_000, tipo: 'evento_especial', gancho: 'Liga MX', etapa: 'confirmada_verbal', dias: 2 },
  // orden_recibida (2)
  { titulo: 'Bimbo Q1 TV+Radio', cuenta_idx: 1, valor: 9_800_000, tipo: 'estacional', gancho: null, etapa: 'orden_recibida', dias: 0 },
  { titulo: 'L\'Oréal Digital Always-On', cuenta_idx: 4, valor: 4_500_000, tipo: 'reforzamiento', gancho: null, etapa: 'orden_recibida', dias: 0 },
  // completada (1)
  { titulo: 'VW Lanzamiento Sedan 2025', cuenta_idx: 7, valor: 7_000_000, tipo: 'lanzamiento', gancho: null, etapa: 'completada', dias: 0 },
  // perdida (2)
  { titulo: 'BBVA App Campaña', cuenta_idx: 10, valor: 5_000_000, tipo: 'lanzamiento', gancho: null, etapa: 'perdida', dias: 0 },
  { titulo: 'Amazon Black Friday TV', cuenta_idx: 11, valor: 8_000_000, tipo: 'tentpole', gancho: 'Black Friday', etapa: 'perdida', dias: 0 },
];

const insertPropuesta = db.prepare(`
  INSERT INTO propuesta (id, cuenta_id, ae_id, titulo, valor_estimado, tipo_oportunidad, gancho_temporal, etapa, dias_sin_actividad, fecha_creacion, fecha_ultima_actividad, razon_perdida)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (let i = 0; i < propuestas.length; i++) {
  const p = propuestas[i];
  const cta = cuentas[p.cuenta_idx];
  const aeId = aeIds[p.cuenta_idx % aeIds.length];
  const created = new Date(Date.now() - (30 + i) * 86400000).toISOString();
  const lastAct = new Date(Date.now() - p.dias * 86400000).toISOString();
  const razon = p.etapa === 'perdida' ? (i === 23 ? 'Presupuesto reasignado a digital directo' : 'Eligieron competencia por precio') : null;

  insertPropuesta.run(id('prop', i + 1), cta.id, aeId, p.titulo, p.valor, p.tipo, p.gancho, p.etapa, p.dias, created, lastAct, razon);
}

// ===========================================================================
// 7. ACTIVIDADES — 80 entries
// ===========================================================================

const tiposActividad = ['llamada', 'whatsapp', 'comida', 'email', 'reunion', 'visita', 'envio_propuesta'];
const sentimientos = ['positivo', 'positivo', 'neutral', 'neutral', 'neutral', 'negativo', 'urgente'];
const resumenes = [
  'Llamé al cliente para dar seguimiento a la propuesta. Quedó de revisar esta semana.',
  'Me escribió por WhatsApp preguntando por disponibilidad de spots en Canal Uno.',
  'Comida con el director de marketing. Muy buena relación, quiere ampliar pauta digital.',
  'Envié el comparativo de precios por email. Esperando respuesta.',
  'Reunión en oficinas del cliente. Presentamos nueva tarjeta de CTV.',
  'Visita al corporativo. Revisamos el plan de descarga del trimestre.',
  'Envié la propuesta formal con desglose por medio.',
  'El cliente pidió un descuento adicional del 8%. Escalé con gerente.',
  'Confirmaron verbalmente la orden. Pendiente IO firmada.',
  'Reunión con el equipo de compras para negociar condiciones.',
  'El planeador de la agencia solicita ajustes al mix de medios.',
  'Llamada rápida para confirmar fechas de vuelo de la campaña.',
  'Me avisaron que el presupuesto se redujo 15%. Ajustando propuesta.',
  'Excelente feedback de la campaña anterior. Quieren repetir formato.',
  'El cliente canceló la reunión. Reagendamos para la próxima semana.',
];

const insertActividad = db.prepare(`
  INSERT INTO actividad (id, ae_id, cuenta_id, propuesta_id, tipo, resumen, sentimiento, fecha)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

for (let i = 0; i < 80; i++) {
  const ctaIdx = i % cuentas.length;
  const aeId = aeIds[ctaIdx % aeIds.length];
  const propId = i < 25 ? id('prop', (i % 25) + 1) : null;
  const daysAgo = Math.floor(Math.random() * 60);
  const fecha = new Date(Date.now() - daysAgo * 86400000).toISOString();

  insertActividad.run(
    id('act', i + 1), aeId, cuentas[ctaIdx].id, propId,
    tiposActividad[i % tiposActividad.length],
    resumenes[i % resumenes.length],
    sentimientos[i % sentimientos.length],
    fecha,
  );
}

// ===========================================================================
// 8. CUOTAS — 8 weeks × 12 AEs
// ===========================================================================

const insertCuota = db.prepare(`INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES (?, ?, 'ae', ?, ?, ?, ?)`);

for (let a = 0; a < Math.min(aeIds.length, 12); a++) {
  const weeklyMeta = 500_000 + Math.random() * 1_000_000;
  for (let w = 1; w <= 8; w++) {
    const factor = 0.6 + Math.random() * 0.6; // 60-120% attainment
    insertCuota.run(id('quo', a * 8 + w), aeIds[a], YEAR, w, Math.round(weeklyMeta), Math.round(weeklyMeta * factor));
  }
}

// ===========================================================================
// 9. INVENTARIO — 15 products
// ===========================================================================

const inventario = [
  { medio: 'tv_abierta', propiedad: 'Canal Uno', formato: 'spot_20s', unidad: 'spot', ref: 65000, piso: 45000, cpm: null },
  { medio: 'tv_abierta', propiedad: 'Canal Uno', formato: 'spot_30s', unidad: 'spot', ref: 85000, piso: 60000, cpm: null },
  { medio: 'tv_abierta', propiedad: 'Canal Dos', formato: 'spot_20s', unidad: 'spot', ref: 45000, piso: 30000, cpm: null },
  { medio: 'tv_abierta', propiedad: 'Canal Dos', formato: 'spot_30s', unidad: 'spot', ref: 62000, piso: 42000, cpm: null },
  { medio: 'ctv', propiedad: 'Apex+', formato: 'pre_roll_15s', unidad: 'impresiones', ref: null, piso: null, cpm: 180 },
  { medio: 'ctv', propiedad: 'Apex+', formato: 'pre_roll_30s', unidad: 'impresiones', ref: null, piso: null, cpm: 250 },
  { medio: 'ctv', propiedad: 'Apex+', formato: 'mid_roll_30s', unidad: 'impresiones', ref: null, piso: null, cpm: 200 },
  { medio: 'radio', propiedad: 'Radio Apex FM CDMX', formato: 'mencion_20s', unidad: 'mencion', ref: 8000, piso: 5000, cpm: null },
  { medio: 'radio', propiedad: 'Radio Apex FM CDMX', formato: 'spot_30s', unidad: 'spot', ref: 12000, piso: 8000, cpm: null },
  { medio: 'radio', propiedad: 'Radio Apex FM Monterrey', formato: 'spot_30s', unidad: 'spot', ref: 9000, piso: 6000, cpm: null },
  { medio: 'radio', propiedad: 'Radio Apex FM Guadalajara', formato: 'spot_30s', unidad: 'spot', ref: 8500, piso: 5500, cpm: null },
  { medio: 'digital', propiedad: 'apex.com.mx', formato: 'banner_header', unidad: 'impresiones', ref: null, piso: null, cpm: 45 },
  { medio: 'digital', propiedad: 'apex.com.mx', formato: 'video_instream', unidad: 'impresiones', ref: null, piso: null, cpm: 120 },
  { medio: 'digital', propiedad: 'deportes.apex.com.mx', formato: 'banner_sidebar', unidad: 'impresiones', ref: null, piso: null, cpm: 55 },
  { medio: 'digital', propiedad: 'Newsletter Apex', formato: 'sponsorship', unidad: 'edicion', ref: 35000, piso: 25000, cpm: null },
];

const insertInventario = db.prepare(`INSERT INTO inventario (id, medio, propiedad, formato, unidad_venta, precio_referencia, precio_piso, cpm_referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

for (let i = 0; i < inventario.length; i++) {
  const inv = inventario[i];
  insertInventario.run(id('inv', i + 1), inv.medio, inv.propiedad, inv.formato, inv.unidad, inv.ref, inv.piso, inv.cpm);
}

// ===========================================================================
// Summary
// ===========================================================================

const counts = {
  personas: (db.prepare('SELECT COUNT(*) as c FROM persona').get() as any).c,
  cuentas: (db.prepare('SELECT COUNT(*) as c FROM cuenta').get() as any).c,
  contactos: (db.prepare('SELECT COUNT(*) as c FROM contacto').get() as any).c,
  contratos: (db.prepare('SELECT COUNT(*) as c FROM contrato').get() as any).c,
  descargas: (db.prepare('SELECT COUNT(*) as c FROM descarga').get() as any).c,
  propuestas: (db.prepare('SELECT COUNT(*) as c FROM propuesta').get() as any).c,
  actividades: (db.prepare('SELECT COUNT(*) as c FROM actividad').get() as any).c,
  cuotas: (db.prepare('SELECT COUNT(*) as c FROM cuota').get() as any).c,
  inventario: (db.prepare('SELECT COUNT(*) as c FROM inventario').get() as any).c,
};

console.log('Seed data loaded:');
console.log(JSON.stringify(counts, null, 2));
