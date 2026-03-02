/**
 * CRM Schema Definitions — Domain-specific for media ad sales
 *
 * 12 tables. All created in the same SQLite database used by the NanoClaw
 * engine (via getDatabase() export).
 *
 * Tables:
 *   - persona: Sales team org chart (ae, gerente, director, vp)
 *   - cuenta: Client accounts (advertisers / agencies)
 *   - contacto: People at client accounts
 *   - contrato: Annual upfront contracts
 *   - descarga: Weekly discharge tracking (52-week plan vs actual)
 *   - propuesta: Proposals (the central CRM object)
 *   - actividad: Logged client interactions
 *   - cuota: Weekly sales quotas
 *   - inventario: Media inventory / rate card
 *   - alerta_log: Alert deduplication log
 *   - email_log: Sent/draft email tracking
 *   - evento_calendario: Calendar event tracking
 */

import type Database from 'better-sqlite3';

export const CRM_TABLES = [
  'persona', 'cuenta', 'contacto', 'contrato', 'descarga',
  'propuesta', 'actividad', 'cuota', 'inventario',
  'alerta_log', 'email_log', 'evento_calendario',
] as const;

export type CrmTableName = typeof CRM_TABLES[number];

export function createCrmSchema(db: Database.Database): void {
  db.exec(`
    -- 1. PERSONA (org chart)
    CREATE TABLE IF NOT EXISTS persona (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      rol TEXT NOT NULL CHECK(rol IN ('ae','gerente','director','vp')),
      reporta_a TEXT REFERENCES persona(id),
      whatsapp_group_folder TEXT,
      email TEXT,
      google_calendar_id TEXT,
      telefono TEXT,
      activo INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_persona_rol ON persona(rol);
    CREATE INDEX IF NOT EXISTS idx_persona_reporta ON persona(reporta_a);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_group_folder
      ON persona(whatsapp_group_folder) WHERE whatsapp_group_folder IS NOT NULL;

    -- 2. CUENTA (Account)
    CREATE TABLE IF NOT EXISTS cuenta (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('directo','agencia')),
      vertical TEXT,
      holding_agencia TEXT,
      agencia_medios TEXT,
      ae_id TEXT REFERENCES persona(id),
      gerente_id TEXT REFERENCES persona(id),
      director_id TEXT REFERENCES persona(id),
      años_relacion INTEGER DEFAULT 0,
      es_fundador INTEGER DEFAULT 0,
      notas TEXT,
      fecha_creacion TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cuenta_ae ON cuenta(ae_id);
    CREATE INDEX IF NOT EXISTS idx_cuenta_gerente ON cuenta(gerente_id);

    -- 3. CONTACTO
    CREATE TABLE IF NOT EXISTS contacto (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      cuenta_id TEXT REFERENCES cuenta(id),
      es_agencia INTEGER DEFAULT 0,
      rol TEXT CHECK(rol IN ('comprador','planeador','decisor','operativo')),
      seniority TEXT CHECK(seniority IN ('junior','senior','director')),
      telefono TEXT,
      email TEXT,
      notas TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contacto_cuenta ON contacto(cuenta_id);

    -- 4. CONTRATO (Annual upfront)
    CREATE TABLE IF NOT EXISTS contrato (
      id TEXT PRIMARY KEY,
      cuenta_id TEXT NOT NULL REFERENCES cuenta(id),
      año INTEGER NOT NULL,
      monto_comprometido REAL NOT NULL,
      fecha_cierre TEXT,
      desglose_medios TEXT,
      plan_descarga_52sem TEXT,
      notas_cierre TEXT,
      estatus TEXT DEFAULT 'negociando'
        CHECK(estatus IN ('negociando','firmado','en_ejecucion','cerrado'))
    );
    CREATE INDEX IF NOT EXISTS idx_contrato_cuenta ON contrato(cuenta_id);
    CREATE INDEX IF NOT EXISTS idx_contrato_año ON contrato(año);

    -- 5. DESCARGA (Weekly discharge tracking)
    CREATE TABLE IF NOT EXISTS descarga (
      id TEXT PRIMARY KEY,
      contrato_id TEXT REFERENCES contrato(id),
      cuenta_id TEXT REFERENCES cuenta(id),
      semana INTEGER NOT NULL CHECK(semana BETWEEN 1 AND 52),
      año INTEGER NOT NULL,
      planificado REAL DEFAULT 0,
      facturado REAL DEFAULT 0,
      gap REAL GENERATED ALWAYS AS (planificado - facturado) STORED,
      gap_acumulado REAL DEFAULT 0,
      por_medio TEXT,
      notas_ae TEXT,
      UNIQUE(cuenta_id, semana, año)
    );
    CREATE INDEX IF NOT EXISTS idx_descarga_cuenta_semana ON descarga(cuenta_id, semana, año);
    CREATE INDEX IF NOT EXISTS idx_descarga_contrato ON descarga(contrato_id);

    -- 6. PROPUESTA (The central CRM object)
    CREATE TABLE IF NOT EXISTS propuesta (
      id TEXT PRIMARY KEY,
      cuenta_id TEXT REFERENCES cuenta(id),
      ae_id TEXT REFERENCES persona(id),
      titulo TEXT NOT NULL,
      valor_estimado REAL,
      medios TEXT,
      tipo_oportunidad TEXT CHECK(tipo_oportunidad IN (
        'estacional','lanzamiento','reforzamiento','evento_especial','tentpole','prospeccion'
      )),
      gancho_temporal TEXT,
      fecha_vuelo_inicio TEXT,
      fecha_vuelo_fin TEXT,
      enviada_a TEXT CHECK(enviada_a IN ('cliente','agencia','ambos')),
      contactos_involucrados TEXT,
      etapa TEXT DEFAULT 'en_preparacion' CHECK(etapa IN (
        'en_preparacion','enviada','en_discusion','en_negociacion',
        'confirmada_verbal','orden_recibida','en_ejecucion',
        'completada','perdida','cancelada'
      )),
      fecha_creacion TEXT DEFAULT (datetime('now')),
      fecha_envio TEXT,
      fecha_ultima_actividad TEXT DEFAULT (datetime('now')),
      fecha_cierre_esperado TEXT,
      dias_sin_actividad INTEGER DEFAULT 0,
      razon_perdida TEXT,
      es_mega INTEGER GENERATED ALWAYS AS (
        CASE WHEN valor_estimado > 15000000 THEN 1 ELSE 0 END
      ) STORED,
      notas TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_propuesta_ae ON propuesta(ae_id);
    CREATE INDEX IF NOT EXISTS idx_propuesta_cuenta ON propuesta(cuenta_id);
    CREATE INDEX IF NOT EXISTS idx_propuesta_etapa ON propuesta(etapa);

    -- 7. ACTIVIDAD
    CREATE TABLE IF NOT EXISTS actividad (
      id TEXT PRIMARY KEY,
      ae_id TEXT REFERENCES persona(id),
      cuenta_id TEXT REFERENCES cuenta(id),
      propuesta_id TEXT REFERENCES propuesta(id),
      contrato_id TEXT REFERENCES contrato(id),
      tipo TEXT CHECK(tipo IN (
        'llamada','whatsapp','comida','email','reunion','visita','envio_propuesta','otro'
      )),
      resumen TEXT NOT NULL,
      sentimiento TEXT CHECK(sentimiento IN ('positivo','neutral','negativo','urgente')),
      siguiente_accion TEXT,
      fecha_siguiente_accion TEXT,
      fecha TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_actividad_ae ON actividad(ae_id);
    CREATE INDEX IF NOT EXISTS idx_actividad_propuesta ON actividad(propuesta_id);
    CREATE INDEX IF NOT EXISTS idx_actividad_fecha ON actividad(fecha);

    -- 8. CUOTA (Weekly quotas)
    CREATE TABLE IF NOT EXISTS cuota (
      id TEXT PRIMARY KEY,
      persona_id TEXT REFERENCES persona(id),
      rol TEXT NOT NULL CHECK(rol IN ('ae','gerente','director')),
      año INTEGER NOT NULL,
      semana INTEGER NOT NULL CHECK(semana BETWEEN 1 AND 52),
      meta_total REAL,
      meta_por_medio TEXT,
      logro REAL DEFAULT 0,
      porcentaje REAL GENERATED ALWAYS AS (
        CASE WHEN meta_total > 0 THEN (logro / meta_total) * 100 ELSE 0 END
      ) STORED,
      UNIQUE(persona_id, año, semana)
    );
    CREATE INDEX IF NOT EXISTS idx_cuota_persona_semana ON cuota(persona_id, año, semana);

    -- 9. INVENTARIO
    CREATE TABLE IF NOT EXISTS inventario (
      id TEXT PRIMARY KEY,
      medio TEXT NOT NULL CHECK(medio IN ('tv_abierta','ctv','radio','digital')),
      propiedad TEXT NOT NULL,
      formato TEXT,
      unidad_venta TEXT,
      precio_referencia REAL,
      precio_piso REAL,
      cpm_referencia REAL,
      disponibilidad TEXT
    );

    -- 10. ALERTA_LOG (prevent duplicate alerts)
    CREATE TABLE IF NOT EXISTS alerta_log (
      id TEXT PRIMARY KEY,
      alerta_tipo TEXT NOT NULL,
      entidad_id TEXT NOT NULL,
      grupo_destino TEXT NOT NULL,
      fecha_envio TEXT DEFAULT (datetime('now')),
      fecha_envio_date TEXT GENERATED ALWAYS AS (date(fecha_envio)) STORED
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerta_dedup
      ON alerta_log(alerta_tipo, entidad_id, grupo_destino, fecha_envio_date);

    -- 11. EMAIL_LOG (track sent emails)
    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY,
      persona_id TEXT REFERENCES persona(id),
      destinatario TEXT NOT NULL,
      asunto TEXT NOT NULL,
      cuerpo TEXT,
      tipo TEXT NOT NULL CHECK(tipo IN ('seguimiento','briefing','alerta','propuesta')),
      propuesta_id TEXT REFERENCES propuesta(id),
      cuenta_id TEXT REFERENCES cuenta(id),
      enviado INTEGER DEFAULT 0,
      fecha_programado TEXT,
      fecha_enviado TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_log_persona ON email_log(persona_id);

    -- 12. EVENTO_CALENDARIO (track created calendar events)
    CREATE TABLE IF NOT EXISTS evento_calendario (
      id TEXT PRIMARY KEY,
      persona_id TEXT REFERENCES persona(id),
      google_event_id TEXT,
      titulo TEXT NOT NULL,
      descripcion TEXT,
      fecha_inicio TEXT NOT NULL,
      fecha_fin TEXT,
      tipo TEXT CHECK(tipo IN ('seguimiento','reunion','tentpole','deadline','briefing')),
      propuesta_id TEXT REFERENCES propuesta(id),
      cuenta_id TEXT REFERENCES cuenta(id),
      creado_por TEXT DEFAULT 'agente' CHECK(creado_por IN ('agente','usuario','sistema'))
    );
    CREATE INDEX IF NOT EXISTS idx_evento_persona ON evento_calendario(persona_id);
  `);
}
