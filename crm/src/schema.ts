/**
 * CRM Schema Definitions — Domain-specific for media ad sales
 *
 * 25 tables. All created in the same SQLite database used by the NanoClaw
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
 *   - crm_events: Sporting/industry events (World Cup, Liga MX, tentpoles)
 *   - crm_documents: Document metadata for RAG pipeline
 *   - crm_embeddings: Document chunk embeddings for RAG search
 *   - aprobacion_registro: Approval workflow audit trail
 *   - insight_comercial: Overnight commercial insight engine
 *   - patron_detectado: Cross-agent lateral pattern detection
 *   - feedback_propuesta: Draft-vs-final delta tracking for learning
 */

import type Database from "better-sqlite3";

export const CRM_TABLES = [
  "persona",
  "cuenta",
  "contacto",
  "contrato",
  "descarga",
  "propuesta",
  "actividad",
  "cuota",
  "inventario",
  "alerta_log",
  "email_log",
  "evento_calendario",
  "crm_events",
  "crm_documents",
  "crm_embeddings",
  "crm_vec_embeddings",
  "crm_memories",
  "crm_fts_embeddings",
  "relacion_ejecutiva",
  "interaccion_ejecutiva",
  "hito_contacto",
  "aprobacion_registro",
  "insight_comercial",
  "patron_detectado",
  "feedback_propuesta",
  "perfil_usuario",
] as const;

export type CrmTableName = (typeof CRM_TABLES)[number];

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
        'borrador_agente','en_preparacion','enviada','en_discusion','en_negociacion',
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
    CREATE INDEX IF NOT EXISTS idx_actividad_sentimiento ON actividad(sentimiento);
  `);

  // -- Phase 8: Additive migrations on actividad --
  // SQLite doesn't support ALTER CHECK or ADD COLUMN IF NOT EXISTS,
  // so we guard each ALTER with a pragma check.
  const activCols = db.prepare("PRAGMA table_info(actividad)").all() as {
    name: string;
  }[];
  const colNames = new Set(activCols.map((c) => c.name));

  if (!colNames.has("audio_ref")) {
    db.exec("ALTER TABLE actividad ADD COLUMN audio_ref TEXT");
  }
  if (!colNames.has("transcripcion")) {
    db.exec("ALTER TABLE actividad ADD COLUMN transcripcion TEXT");
  }
  if (!colNames.has("sentimiento_score")) {
    db.exec("ALTER TABLE actividad ADD COLUMN sentimiento_score REAL");
  }
  if (!colNames.has("tipo_mensaje")) {
    db.exec(
      "ALTER TABLE actividad ADD COLUMN tipo_mensaje TEXT DEFAULT 'texto'",
    );
  }

  // -- Phase 9: Additive migrations on contacto --
  const contactoCols = db.prepare("PRAGMA table_info(contacto)").all() as {
    name: string;
  }[];
  const contactoColNames = new Set(contactoCols.map((c) => c.name));

  if (!contactoColNames.has("es_ejecutivo")) {
    db.exec("ALTER TABLE contacto ADD COLUMN es_ejecutivo INTEGER DEFAULT 0");
  }
  if (!contactoColNames.has("titulo")) {
    db.exec("ALTER TABLE contacto ADD COLUMN titulo TEXT");
  }
  if (!contactoColNames.has("organizacion")) {
    db.exec("ALTER TABLE contacto ADD COLUMN organizacion TEXT");
  }
  if (!contactoColNames.has("linkedin_url")) {
    db.exec("ALTER TABLE contacto ADD COLUMN linkedin_url TEXT");
  }
  if (!contactoColNames.has("notas_personales")) {
    db.exec("ALTER TABLE contacto ADD COLUMN notas_personales TEXT");
  }
  if (!contactoColNames.has("fecha_nacimiento")) {
    db.exec("ALTER TABLE contacto ADD COLUMN fecha_nacimiento TEXT");
  }

  // -- Phase 10: Approval workflow columns on cuenta + contacto --
  const cuentaCols = db.prepare("PRAGMA table_info(cuenta)").all() as {
    name: string;
  }[];
  const cuentaColNames = new Set(cuentaCols.map((c) => c.name));

  if (!cuentaColNames.has("estado")) {
    db.exec("ALTER TABLE cuenta ADD COLUMN estado TEXT DEFAULT 'activo'");
    db.exec("UPDATE cuenta SET estado = 'activo' WHERE estado IS NULL");
  }
  if (!cuentaColNames.has("creado_por")) {
    db.exec("ALTER TABLE cuenta ADD COLUMN creado_por TEXT");
  }
  if (!cuentaColNames.has("fecha_activacion")) {
    db.exec("ALTER TABLE cuenta ADD COLUMN fecha_activacion TEXT");
  }

  if (!contactoColNames.has("estado")) {
    db.exec("ALTER TABLE contacto ADD COLUMN estado TEXT DEFAULT 'activo'");
    db.exec("UPDATE contacto SET estado = 'activo' WHERE estado IS NULL");
  }
  if (!contactoColNames.has("creado_por")) {
    db.exec("ALTER TABLE contacto ADD COLUMN creado_por TEXT");
  }
  if (!contactoColNames.has("fecha_activacion")) {
    db.exec("ALTER TABLE contacto ADD COLUMN fecha_activacion TEXT");
  }

  // -- Phase 11: Proposal draft columns + CHECK migration on propuesta --
  const propCols = db.prepare("PRAGMA table_info(propuesta)").all() as {
    name: string;
  }[];
  const propColNames = new Set(propCols.map((c) => c.name));

  if (!propColNames.has("agente_razonamiento")) {
    db.exec("ALTER TABLE propuesta ADD COLUMN agente_razonamiento TEXT");
  }
  if (!propColNames.has("confianza")) {
    db.exec("ALTER TABLE propuesta ADD COLUMN confianza REAL");
  }
  if (!propColNames.has("insight_origen_id")) {
    db.exec("ALTER TABLE propuesta ADD COLUMN insight_origen_id TEXT");
  }

  // Migrate CHECK constraint to include borrador_agente (SQLite can't ALTER CHECK).
  // Only runs if the CHECK doesn't already include borrador_agente.
  const propSql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='propuesta'",
      )
      .get() as { sql: string } | undefined
  )?.sql;
  if (propSql && !propSql.includes("borrador_agente")) {
    db.pragma("foreign_keys = OFF");
    db.exec("DROP TABLE IF EXISTS propuesta_new");
    db.exec(`
      CREATE TABLE propuesta_new (
        id TEXT PRIMARY KEY, cuenta_id TEXT, ae_id TEXT, titulo TEXT NOT NULL,
        valor_estimado REAL, medios TEXT,
        tipo_oportunidad TEXT CHECK(tipo_oportunidad IN ('estacional','lanzamiento','reforzamiento','evento_especial','tentpole','prospeccion')),
        gancho_temporal TEXT, fecha_vuelo_inicio TEXT, fecha_vuelo_fin TEXT,
        enviada_a TEXT CHECK(enviada_a IN ('cliente','agencia','ambos')),
        contactos_involucrados TEXT,
        etapa TEXT DEFAULT 'en_preparacion' CHECK(etapa IN ('borrador_agente','en_preparacion','enviada','en_discusion','en_negociacion','confirmada_verbal','orden_recibida','en_ejecucion','completada','perdida','cancelada')),
        fecha_creacion TEXT DEFAULT (datetime('now')), fecha_envio TEXT,
        fecha_ultima_actividad TEXT DEFAULT (datetime('now')), fecha_cierre_esperado TEXT,
        dias_sin_actividad INTEGER DEFAULT 0, razon_perdida TEXT,
        es_mega INTEGER GENERATED ALWAYS AS (CASE WHEN valor_estimado > 15000000 THEN 1 ELSE 0 END) STORED,
        notas TEXT, agente_razonamiento TEXT, confianza REAL, insight_origen_id TEXT
      )
    `);
    db.exec(
      `INSERT INTO propuesta_new (id,cuenta_id,ae_id,titulo,valor_estimado,medios,tipo_oportunidad,gancho_temporal,fecha_vuelo_inicio,fecha_vuelo_fin,enviada_a,contactos_involucrados,etapa,fecha_creacion,fecha_envio,fecha_ultima_actividad,fecha_cierre_esperado,dias_sin_actividad,razon_perdida,notas,agente_razonamiento,confianza,insight_origen_id)
       SELECT id,cuenta_id,ae_id,titulo,valor_estimado,medios,tipo_oportunidad,gancho_temporal,fecha_vuelo_inicio,fecha_vuelo_fin,enviada_a,contactos_involucrados,etapa,fecha_creacion,fecha_envio,fecha_ultima_actividad,fecha_cierre_esperado,dias_sin_actividad,razon_perdida,notas,agente_razonamiento,confianza,insight_origen_id
       FROM propuesta`,
    );
    db.exec("DROP TABLE propuesta");
    db.exec("ALTER TABLE propuesta_new RENAME TO propuesta");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_propuesta_ae ON propuesta(ae_id);
      CREATE INDEX IF NOT EXISTS idx_propuesta_cuenta ON propuesta(cuenta_id);
      CREATE INDEX IF NOT EXISTS idx_propuesta_etapa ON propuesta(etapa);
    `);
    db.pragma("foreign_keys = ON");
  }

  db.exec(`
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

    -- 13. CRM_EVENTS (sporting/industry events, NOT calendar entries)
    CREATE TABLE IF NOT EXISTS crm_events (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      tipo TEXT CHECK(tipo IN ('tentpole','deportivo','estacional','industria')),
      fecha_inicio TEXT NOT NULL,
      fecha_fin TEXT,
      inventario_total TEXT,
      inventario_vendido TEXT,
      meta_ingresos REAL,
      ingresos_actual REAL DEFAULT 0,
      prioridad TEXT DEFAULT 'media' CHECK(prioridad IN ('alta','media','baja')),
      notas TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_crm_events_fecha ON crm_events(fecha_inicio);

    -- 14. CRM_DOCUMENTS (document metadata for RAG pipeline)
    CREATE TABLE IF NOT EXISTS crm_documents (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK(source IN ('drive','email','manual')),
      source_id TEXT,
      persona_id TEXT REFERENCES persona(id),
      titulo TEXT NOT NULL,
      tipo_doc TEXT,
      contenido_hash TEXT,
      chunk_count INTEGER DEFAULT 0,
      fecha_sync TEXT DEFAULT (datetime('now')),
      fecha_modificacion TEXT,
      tamano_bytes INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_crm_docs_persona ON crm_documents(persona_id);
    CREATE INDEX IF NOT EXISTS idx_crm_docs_source ON crm_documents(source, source_id);

    -- 15. CRM_EMBEDDINGS (document chunk embeddings for RAG search)
    CREATE TABLE IF NOT EXISTS crm_embeddings (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES crm_documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      contenido TEXT NOT NULL,
      embedding BLOB,
      UNIQUE(document_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_crm_embed_doc ON crm_embeddings(document_id);

    -- 16. CRM_VEC_EMBEDDINGS (sqlite-vec virtual table for KNN search)
    CREATE VIRTUAL TABLE IF NOT EXISTS crm_vec_embeddings USING vec0(
      embedding float[1024]
    );

    -- 17. CRM_MEMORIES (long-term agent memory, SQLite fallback for Hindsight)
    CREATE TABLE IF NOT EXISTS crm_memories (
      id TEXT PRIMARY KEY,
      persona_id TEXT REFERENCES persona(id),
      banco TEXT NOT NULL CHECK(banco IN ('crm-sales','crm-accounts','crm-team','crm-user')),
      contenido TEXT NOT NULL,
      etiquetas TEXT,
      fecha_creacion TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_crm_memories_persona ON crm_memories(persona_id);
    CREATE INDEX IF NOT EXISTS idx_crm_memories_banco ON crm_memories(banco);

    -- 18. CRM_FTS_EMBEDDINGS (FTS5 keyword search alongside vector KNN)
    CREATE VIRTUAL TABLE IF NOT EXISTS crm_fts_embeddings USING fts5(
      contenido,
      content='crm_embeddings',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    -- 19. RELACION_EJECUTIVA (Dir/VP executive relationship tracking)
    CREATE TABLE IF NOT EXISTS relacion_ejecutiva (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL REFERENCES persona(id),
      contacto_id TEXT NOT NULL REFERENCES contacto(id),
      tipo TEXT NOT NULL CHECK(tipo IN ('cliente','agencia','industria','interna')),
      importancia TEXT DEFAULT 'media' CHECK(importancia IN ('critica','alta','media','baja')),
      notas_estrategicas TEXT,
      warmth_score REAL DEFAULT 50.0,
      warmth_updated TEXT,
      fecha_creacion TEXT DEFAULT (datetime('now')),
      UNIQUE(persona_id, contacto_id)
    );
    CREATE INDEX IF NOT EXISTS idx_relej_persona ON relacion_ejecutiva(persona_id);
    CREATE INDEX IF NOT EXISTS idx_relej_contacto ON relacion_ejecutiva(contacto_id);
    CREATE INDEX IF NOT EXISTS idx_relej_warmth ON relacion_ejecutiva(warmth_score);

    -- 20. INTERACCION_EJECUTIVA (executive interaction log)
    CREATE TABLE IF NOT EXISTS interaccion_ejecutiva (
      id TEXT PRIMARY KEY,
      relacion_id TEXT NOT NULL REFERENCES relacion_ejecutiva(id),
      tipo TEXT NOT NULL CHECK(tipo IN ('llamada','comida','evento','reunion','email','regalo','presentacion','otro')),
      resumen TEXT NOT NULL,
      calidad TEXT DEFAULT 'normal' CHECK(calidad IN ('excepcional','buena','normal','superficial')),
      lugar TEXT,
      fecha TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_intej_relacion ON interaccion_ejecutiva(relacion_id);
    CREATE INDEX IF NOT EXISTS idx_intej_fecha ON interaccion_ejecutiva(fecha);

    -- 21. HITO_CONTACTO (contact milestones: birthdays, promotions, renewals)
    CREATE TABLE IF NOT EXISTS hito_contacto (
      id TEXT PRIMARY KEY,
      contacto_id TEXT NOT NULL REFERENCES contacto(id),
      tipo TEXT NOT NULL CHECK(tipo IN ('cumpleanos','ascenso','cambio_empresa','renovacion','aniversario','otro')),
      titulo TEXT NOT NULL,
      fecha TEXT NOT NULL,
      recurrente INTEGER DEFAULT 0,
      notas TEXT,
      fecha_creacion TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hito_contacto ON hito_contacto(contacto_id);
    CREATE INDEX IF NOT EXISTS idx_hito_fecha ON hito_contacto(fecha);

    -- 22. APROBACION_REGISTRO (approval workflow audit trail)
    CREATE TABLE IF NOT EXISTS aprobacion_registro (
      id TEXT PRIMARY KEY,
      entidad_tipo TEXT NOT NULL CHECK(entidad_tipo IN ('cuenta','contacto')),
      entidad_id TEXT NOT NULL,
      accion TEXT NOT NULL CHECK(accion IN ('creado','aprobado','rechazado','impugnado','resuelto','auto_activado')),
      actor_id TEXT NOT NULL,
      actor_rol TEXT NOT NULL,
      estado_anterior TEXT,
      estado_nuevo TEXT NOT NULL,
      motivo TEXT,
      fecha TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cuenta_estado ON cuenta(estado);
    CREATE INDEX IF NOT EXISTS idx_contacto_estado ON contacto(estado);

    -- 23. INSIGHT_COMERCIAL (overnight commercial intelligence)
    CREATE TABLE IF NOT EXISTS insight_comercial (
      id TEXT PRIMARY KEY,
      tipo TEXT NOT NULL CHECK(tipo IN (
        'oportunidad_calendario','oportunidad_inventario','oportunidad_gap',
        'oportunidad_crosssell','oportunidad_mercado','riesgo','patron','recomendacion'
      )),
      cuenta_id TEXT REFERENCES cuenta(id),
      ae_id TEXT REFERENCES persona(id),
      propuesta_id TEXT REFERENCES propuesta(id),
      evento_id TEXT,
      titulo TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      accion_recomendada TEXT,
      datos_soporte TEXT,
      confianza REAL NOT NULL CHECK(confianza BETWEEN 0 AND 1),
      sample_size INTEGER,
      valor_potencial REAL,
      estado TEXT DEFAULT 'nuevo' CHECK(estado IN (
        'nuevo','briefing','aceptado','convertido','descartado','expirado'
      )),
      razon_descarte TEXT,
      propuesta_generada_id TEXT REFERENCES propuesta(id),
      fecha_generacion TEXT DEFAULT (datetime('now')),
      fecha_expiracion TEXT,
      fecha_accion TEXT,
      lote_nocturno TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_insight_ae ON insight_comercial(ae_id);
    CREATE INDEX IF NOT EXISTS idx_insight_cuenta ON insight_comercial(cuenta_id);
    CREATE INDEX IF NOT EXISTS idx_insight_estado ON insight_comercial(estado);
    CREATE INDEX IF NOT EXISTS idx_insight_tipo ON insight_comercial(tipo);
    CREATE INDEX IF NOT EXISTS idx_insight_lote ON insight_comercial(lote_nocturno);

    -- 24. PATRON_DETECTADO (cross-agent lateral pattern detection)
    CREATE TABLE IF NOT EXISTS patron_detectado (
      id TEXT PRIMARY KEY,
      tipo TEXT NOT NULL CHECK(tipo IN (
        'tendencia_vertical','movimiento_holding','conflicto_inventario',
        'senal_competitiva','correlacion_winloss','concentracion_riesgo'
      )),
      descripcion TEXT NOT NULL,
      datos_json TEXT,
      sample_size INTEGER,
      confianza REAL CHECK(confianza BETWEEN 0 AND 1),
      personas_afectadas TEXT,
      cuentas_afectadas TEXT,
      nivel_minimo TEXT NOT NULL CHECK(nivel_minimo IN ('ae','gerente','director','vp')),
      accion_recomendada TEXT,
      activo INTEGER DEFAULT 1,
      fecha_deteccion TEXT DEFAULT (datetime('now')),
      lote_nocturno TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_patron_tipo ON patron_detectado(tipo);
    CREATE INDEX IF NOT EXISTS idx_patron_nivel ON patron_detectado(nivel_minimo);
    CREATE INDEX IF NOT EXISTS idx_patron_activo ON patron_detectado(activo);

    -- 25. FEEDBACK_PROPUESTA (draft-vs-final delta tracking)
    CREATE TABLE IF NOT EXISTS feedback_propuesta (
      id TEXT PRIMARY KEY,
      propuesta_id TEXT NOT NULL REFERENCES propuesta(id),
      insight_id TEXT,
      ae_id TEXT NOT NULL REFERENCES persona(id),
      borrador_titulo TEXT,
      borrador_valor REAL,
      borrador_medios TEXT,
      borrador_razonamiento TEXT,
      final_titulo TEXT,
      final_valor REAL,
      final_medios TEXT,
      delta_valor REAL,
      delta_descripcion TEXT,
      resultado TEXT CHECK(resultado IN (
        'aceptado_sin_cambios','aceptado_con_cambios','descartado'
      )),
      fecha_borrador TEXT,
      fecha_accion TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_ae ON feedback_propuesta(ae_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_resultado ON feedback_propuesta(resultado);
  `);

  // Note: No FTS5 delete trigger. External content FTS5 tables corrupt when
  // the delete command fires for rows that were never indexed (e.g. test data).
  // Orphaned FTS5 entries are harmless — the JOIN in searchDocumentsKeyword
  // filters them out since the source crm_embeddings row no longer exists.

  // -------------------------------------------------------------------------
  // 26. PERFIL_USUARIO (structured user profile for agent personalization)
  // -------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS perfil_usuario (
      persona_id TEXT PRIMARY KEY REFERENCES persona(id),
      estilo_comunicacion TEXT,
      preferencias_briefing TEXT,
      horario_trabajo TEXT,
      datos_personales TEXT,
      motivadores TEXT,
      notas TEXT,
      fecha_actualizacion TEXT DEFAULT (datetime('now'))
    );
  `);

  // -------------------------------------------------------------------------
  // Migration: add 'crm-user' to crm_memories banco CHECK constraint
  // -------------------------------------------------------------------------
  const memSql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='crm_memories'",
      )
      .get() as { sql: string } | undefined
  )?.sql;
  if (memSql && !memSql.includes("crm-user")) {
    db.pragma("foreign_keys = OFF");
    db.exec("DROP TABLE IF EXISTS crm_memories_new");
    db.exec(`
      CREATE TABLE crm_memories_new (
        id TEXT PRIMARY KEY,
        persona_id TEXT REFERENCES persona(id),
        banco TEXT NOT NULL CHECK(banco IN ('crm-sales','crm-accounts','crm-team','crm-user')),
        contenido TEXT NOT NULL,
        etiquetas TEXT,
        fecha_creacion TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(
      `INSERT INTO crm_memories_new (id, persona_id, banco, contenido, etiquetas, fecha_creacion)
       SELECT id, persona_id, banco, contenido, etiquetas, fecha_creacion FROM crm_memories`,
    );
    db.exec("DROP TABLE crm_memories");
    db.exec("ALTER TABLE crm_memories_new RENAME TO crm_memories");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_crm_memories_persona ON crm_memories(persona_id);
      CREATE INDEX IF NOT EXISTS idx_crm_memories_banco ON crm_memories(banco);
    `);
    db.pragma("foreign_keys = ON");
  }
}
