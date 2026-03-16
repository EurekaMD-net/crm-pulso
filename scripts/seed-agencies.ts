#!/usr/bin/env tsx
/**
 * Seed Agency Data — media agencies, agency contacts, and account linkages.
 *
 * In Mexican broadcast ad sales, agencies (agencias de medios) are intermediaries
 * between advertisers and media companies. Each advertiser may work through one
 * or more agencies. Agency contacts (planners, buyers) are key to the sales process.
 *
 * This script:
 * 1. Sets holding_agencia and agencia_medios on existing agency-type accounts
 * 2. Creates agency contact records (es_agencia = 1) for the major agencies
 * 3. Links agency contacts to the accounts they manage
 * 4. Adds activities involving agency contacts
 * 5. Seeds Hindsight memories for agency intelligence
 */

import Database from "better-sqlite3";

const db = new Database("data/store/crm.db");

// ---------------------------------------------------------------------------
// 1. Update agency-type accounts with holding and agency info
// ---------------------------------------------------------------------------

const agencyMappings = [
  { id: "cta-003", holding: "GroupM (WPP)", agencia: "Mindshare" },
  { id: "cta-004", holding: "GroupM (WPP)", agencia: "Wavemaker" },
  { id: "cta-005", holding: "Publicis Groupe", agencia: "Zenith" },
  { id: "cta-008", holding: "Omnicom Media Group", agencia: "PHD" },
  { id: "cta-009", holding: "Publicis Groupe", agencia: "Starcom" },
  {
    id: "cta-010",
    holding: "IPG Mediabrands",
    agencia: "UM (Universal McCann)",
  },
];

const updateAccount = db.prepare(
  "UPDATE cuenta SET holding_agencia = ?, agencia_medios = ? WHERE id = ?",
);
for (const m of agencyMappings) {
  updateAccount.run(m.holding, m.agencia, m.id);
}
console.log(`Updated ${agencyMappings.length} accounts with agency info`);

// ---------------------------------------------------------------------------
// 2. Create agency contacts (es_agencia = 1)
// ---------------------------------------------------------------------------

const agencyContacts = [
  // Mindshare (handles P&G)
  {
    id: "con-ag-001",
    nombre: "Alejandra Vidal Romero",
    cuenta_id: "cta-003",
    es_agencia: 1,
    rol: "planeador",
    seniority: "director",
    titulo: "Directora de Planeacion",
    organizacion: "Mindshare Mexico",
    email: "avidal@mindshare.mx",
    notas_personales:
      "15 anos en GroupM. Controla la asignacion de presupuesto para todos los clientes WPP en Mexico. Muy rigurosa con los CPMs. Si ella aprueba, el deal pasa.",
  },
  {
    id: "con-ag-002",
    nombre: "Diego Paredes Soto",
    cuenta_id: "cta-003",
    es_agencia: 1,
    rol: "comprador",
    seniority: "senior",
    titulo: "Buyer Senior",
    organizacion: "Mindshare Mexico",
    email: "dparedes@mindshare.mx",
    notas_personales:
      "Ejecuta las ordenes de compra de Alejandra. Muy detallista con fechas y formatos. Responde rapido por WhatsApp.",
  },

  // Wavemaker (handles Unilever)
  {
    id: "con-ag-003",
    nombre: "Fernanda Rios Delgado",
    cuenta_id: "cta-004",
    es_agencia: 1,
    rol: "planeador",
    seniority: "director",
    titulo: "VP de Estrategia de Medios",
    organizacion: "Wavemaker Mexico",
    email: "frios@wavemaker.mx",
    notas_personales:
      "Ex-OMD. Visionaria en CTV y programatica. Empuja a los clientes hacia digital. Aliada natural para vender CTV. Habla en todos los foros de la industria.",
  },
  {
    id: "con-ag-004",
    nombre: "Luis Enrique Guzman",
    cuenta_id: "cta-004",
    es_agencia: 1,
    rol: "comprador",
    seniority: "senior",
    titulo: "Group Buying Director",
    organizacion: "Wavemaker Mexico",
    email: "lguzman@wavemaker.mx",
    notas_personales:
      "Negocia duro pero justo. Siempre pide added value (spots bonificados). Tiene buena relacion con nuestro equipo de trafico.",
  },

  // Zenith (handles L'Oréal)
  {
    id: "con-ag-005",
    nombre: "Paulina Estrada Cisneros",
    cuenta_id: "cta-005",
    es_agencia: 1,
    rol: "planeador",
    seniority: "senior",
    titulo: "Media Planning Manager",
    organizacion: "Zenith Mexico",
    email: "pestrada@zenith.mx",
    notas_personales:
      "Joven pero muy competente. L'Oreal es su cuenta principal. Trabaja de cerca con Isabela Navarro (cliente). Le gustan las presentaciones visuales con datos.",
  },

  // PHD (handles Volkswagen)
  {
    id: "con-ag-006",
    nombre: "Rodrigo Blanco Fuentes",
    cuenta_id: "cta-008",
    es_agencia: 1,
    rol: "planeador",
    seniority: "director",
    titulo: "Director de Medios Automotriz",
    organizacion: "PHD Mexico (OMG)",
    email: "rblanco@phd.mx",
    notas_personales:
      "Especialista en automotriz. Maneja VW, Audi, y Porsche para PHD. Proceso de aprobacion largo (pasa por Wolfsburg via Hans). Le gusta el futbol y el padel.",
  },

  // Starcom (handles Nestlé)
  {
    id: "con-ag-007",
    nombre: "Carolina Mendez Avila",
    cuenta_id: "cta-009",
    es_agencia: 1,
    rol: "planeador",
    seniority: "senior",
    titulo: "Account Director",
    organizacion: "Starcom Mexico",
    email: "cmendez@starcom.mx",
    notas_personales:
      "Maneja Nestle y otros CPG para Starcom. Buena relacion con Eduardo Flores (cliente). Pragmatica — le importa mas el resultado que la creatividad del plan.",
  },

  // UM (handles Colgate-Palmolive)
  {
    id: "con-ag-008",
    nombre: "Marco Antonio Luna Reyes",
    cuenta_id: "cta-010",
    es_agencia: 1,
    rol: "comprador",
    seniority: "director",
    titulo: "Buying Director",
    organizacion: "UM (Universal McCann) Mexico",
    email: "mluna@um.mx",
    notas_personales:
      "Veterano de IPG. 20+ anos comprando medios. Conoce todos los rate cards de memoria. Leal a proveedores que cumplen. Le gusta el tequila y los puros.",
  },

  // Additional: centralized agency contacts not tied to one account
  {
    id: "con-ag-009",
    nombre: "Mariana Velasco Torres",
    cuenta_id: "cta-003",
    es_agencia: 1,
    rol: "operativo",
    seniority: "junior",
    titulo: "Media Coordinator",
    organizacion: "Mindshare Mexico",
    email: "mvelasco@mindshare.mx",
    notas_personales:
      "Coordina trafficking y reportes para toda la cartera de Mindshare. Punto de contacto para ordenes de compra y materiales.",
  },
  {
    id: "con-ag-010",
    nombre: "Ivan Guerrero Padilla",
    cuenta_id: "cta-004",
    es_agencia: 1,
    rol: "operativo",
    seniority: "junior",
    titulo: "Digital Coordinator",
    organizacion: "Wavemaker Mexico",
    email: "iguerrero@wavemaker.mx",
    notas_personales:
      "Maneja la parte digital y CTV de los planes de Wavemaker. Muy tech-savvy. Buen contacto para temas de ad-serving y tracking.",
  },
];

const insertContact = db.prepare(
  "INSERT OR IGNORE INTO contacto (id, nombre, cuenta_id, es_agencia, rol, seniority, titulo, organizacion, email, notas_personales) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
let contactN = 0;
for (const c of agencyContacts) {
  const r = insertContact.run(
    c.id,
    c.nombre,
    c.cuenta_id,
    c.es_agencia,
    c.rol,
    c.seniority,
    c.titulo,
    c.organizacion,
    c.email,
    c.notas_personales,
  );
  if (r.changes > 0) contactN++;
}
console.log(`Created ${contactN} agency contacts`);

// ---------------------------------------------------------------------------
// 3. Seed activities involving agency contacts
// ---------------------------------------------------------------------------

const now = Date.now();
const agencyActivities = [
  // Mindshare / P&G
  {
    ae: "per-012",
    cuenta: "cta-003",
    tipo: "reunion",
    resumen:
      "Reunion con Alejandra Vidal (Mindshare) para revisar plan de medios Q2 de P&G. Pide CPM competitivo en TV abierta vs año pasado. Fernando Martinez (cliente) quiere ver numeros antes del viernes.",
    sentimiento: "neutral",
    days: 3,
  },
  {
    ae: "per-012",
    cuenta: "cta-003",
    tipo: "email",
    resumen:
      "Diego Paredes (Mindshare) envio la OC de P&G para campaña de Ariel. $2.8M en TV + radio. Confirmar disponibilidad de spots.",
    sentimiento: "positivo",
    days: 1,
  },

  // Wavemaker / Unilever
  {
    ae: "per-013",
    cuenta: "cta-004",
    tipo: "comida",
    resumen:
      "Comida con Fernanda Rios (Wavemaker) y Carlos Dominguez (Unilever). Fernanda empuja fuerte CTV para Unilever Q2. Carlos abierto. Oportunidad de $4M+ si armamos paquete CTV+linear.",
    sentimiento: "positivo",
    days: 5,
  },
  {
    ae: "per-013",
    cuenta: "cta-004",
    tipo: "whatsapp",
    resumen:
      "Luis Enrique Guzman (Wavemaker) pregunta por disponibilidad en prime time para Knorr. Quiere 3 semanas en mayo. Pide bonificacion de 15%.",
    sentimiento: "neutral",
    days: 2,
  },

  // Zenith / L'Oréal
  {
    ae: "per-015",
    cuenta: "cta-005",
    tipo: "reunion",
    resumen:
      "Presentacion de resultados de campaña L'Oreal a Paulina Estrada (Zenith) e Isabela Navarro (cliente). Reach CTV supero expectativas. Paulina impresionada — pide propuesta para H2.",
    sentimiento: "positivo",
    days: 4,
  },

  // PHD / Volkswagen
  {
    ae: "per-018",
    cuenta: "cta-008",
    tipo: "llamada",
    resumen:
      "Rodrigo Blanco (PHD) llamo para avisar que VW recorta presupuesto Q2 en 20%. Wolfsburg decidio. Hans Mueller (cliente) no puede hacer nada. Ajustar plan.",
    sentimiento: "negativo",
    days: 6,
  },
  {
    ae: "per-018",
    cuenta: "cta-008",
    tipo: "email",
    resumen:
      "Envie plan ajustado a Rodrigo Blanco (PHD) con recorte de 20% en TV, manteniendo digital intacto. Pide aprobacion de Hans.",
    sentimiento: "neutral",
    days: 2,
  },

  // Starcom / Nestlé
  {
    ae: "per-020",
    cuenta: "cta-009",
    tipo: "whatsapp",
    resumen:
      "Carolina Mendez (Starcom) confirma que Nestle aprueba presupuesto para campaña de Nescafe en TV abierta. $3.5M. Eduardo Flores (cliente) da visto bueno.",
    sentimiento: "positivo",
    days: 1,
  },

  // UM / Colgate-Palmolive
  {
    ae: "per-021",
    cuenta: "cta-010",
    tipo: "reunion",
    resumen:
      "Reunion de negociacion con Marco Antonio Luna (UM) para renovacion anual de Colgate. Pide 8% de descuento vs año pasado. Raul Perez (cliente) presente. Ofrecimos 5% + added value en digital.",
    sentimiento: "neutral",
    days: 7,
  },
];

const insertAct = db.prepare(
  "INSERT OR IGNORE INTO actividad (id, ae_id, cuenta_id, tipo, resumen, sentimiento, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
let actN = 0;
for (let i = 0; i < agencyActivities.length; i++) {
  const a = agencyActivities[i];
  const fecha = new Date(now - a.days * 86_400_000).toISOString();
  const r = insertAct.run(
    `ag-act-${i}`,
    a.ae,
    a.cuenta,
    a.tipo,
    a.resumen,
    a.sentimiento,
    fecha,
  );
  if (r.changes > 0) actN++;
}
console.log(`Created ${actN} agency-related activities`);

// ---------------------------------------------------------------------------
// 4. Seed Hindsight memories for agency intelligence
// ---------------------------------------------------------------------------

async function seedMemory(bank: string, content: string) {
  try {
    await fetch(`http://localhost:8888/v1/default/banks/${bank}/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ content }], async: false }),
    });
    return true;
  } catch {
    return false;
  }
}

async function seedMemories() {
  const memories = [
    // Agency relationship intelligence
    {
      bank: "crm-accounts",
      content:
        "Mindshare (GroupM/WPP) maneja P&G en Mexico. Contacto clave: Alejandra Vidal (Dir Planeacion) — controla asignacion de presupuesto. Diego Paredes ejecuta OCs. Proceso: Alejandra aprueba plan → Diego emite OC → nosotros confirmamos.",
    },
    {
      bank: "crm-accounts",
      content:
        "Wavemaker (GroupM/WPP) maneja Unilever en Mexico. Contacto clave: Fernanda Rios (VP Estrategia) — aliada natural para CTV, empuja digital. Luis Enrique Guzman negocia compras, siempre pide bonificacion 15%.",
    },
    {
      bank: "crm-accounts",
      content:
        "Zenith (Publicis) maneja L'Oreal en Mexico. Paulina Estrada es la planeadora principal. Trabaja de cerca con Isabela Navarro (cliente). Le gustan presentaciones visuales con datos de reach.",
    },
    {
      bank: "crm-accounts",
      content:
        "PHD (Omnicom) maneja Volkswagen en Mexico. Rodrigo Blanco es especialista automotriz (VW, Audi, Porsche). Proceso largo — todo pasa por Wolfsburg via Hans Mueller. Paciencia estrategica.",
    },
    {
      bank: "crm-accounts",
      content:
        "Starcom (Publicis) maneja Nestle en Mexico. Carolina Mendez es Account Director. Pragmatica — resultados sobre creatividad. Buena relacion con Eduardo Flores (cliente).",
    },
    {
      bank: "crm-accounts",
      content:
        "UM/Universal McCann (IPG) maneja Colgate-Palmolive en Mexico. Marco Antonio Luna es Buying Director veterano (20+ anos). Conoce rate cards de memoria. Leal a proveedores que cumplen.",
    },
    // Agency dynamics
    {
      bank: "crm-sales",
      content:
        "En cuentas de agencia, hay dos capas de decision: el cliente (anunciante) define presupuesto y objetivos, la agencia (planeador/comprador) define plan de medios y ejecuta compra. Hay que cultivar ambas relaciones. La agencia puede bloquear o impulsar un deal.",
    },
    {
      bank: "crm-sales",
      content:
        "Holdings de agencias en Mexico: GroupM (WPP) es el mas grande — Mindshare, Wavemaker, MediaCom. Publicis Groupe — Zenith, Starcom. Omnicom — PHD, OMD. IPG — UM, Initiative. Dentsu — Carat, iProspect. Cada holding negocia deals master que afectan a todos sus clientes.",
    },
    {
      bank: "crm-sales",
      content:
        "Patron: agencias de medios siempre piden bonificacion (spots gratis) y added value (digital, eventos, menciones). Es parte del juego. Ofrecer 5-10% bonificacion proactivamente genera goodwill sin afectar margen significativamente.",
    },
  ];

  let ok = 0;
  for (const m of memories) {
    if (await seedMemory(m.bank, m.content)) ok++;
  }
  console.log(`Seeded ${ok} agency memories into Hindsight`);
}

await seedMemories();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const summary = db
  .prepare(
    `
  SELECT
    (SELECT COUNT(*) FROM contacto WHERE es_agencia = 1) as agency_contacts,
    (SELECT COUNT(*) FROM cuenta WHERE agencia_medios IS NOT NULL AND agencia_medios != '') as accounts_with_agency,
    (SELECT COUNT(*) FROM actividad WHERE id LIKE 'ag-act-%') as agency_activities
`,
  )
  .get() as any;

console.log("\nAgency seed summary:", JSON.stringify(summary, null, 2));
db.close();
