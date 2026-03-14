import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, it, expect, beforeEach } from "vitest";
import { createCrmSchema, CRM_TABLES } from "../src/schema.js";

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  db.pragma("foreign_keys = ON");
  createCrmSchema(db);
});

describe("CRM Schema — tables", () => {
  it("creates all 18 CRM tables", () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all()
      .map((r: any) => r.name);

    for (const t of CRM_TABLES) {
      expect(tables).toContain(t);
    }
  });

  it("is idempotent (calling twice does not error)", () => {
    expect(() => createCrmSchema(db)).not.toThrow();
  });
});

describe("CRM Schema — indexes", () => {
  it("creates all expected indexes", () => {
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`,
      )
      .all()
      .map((r: any) => r.name);

    const expected = [
      "idx_persona_rol",
      "idx_persona_reporta",
      "idx_persona_group_folder",
      "idx_cuenta_ae",
      "idx_cuenta_gerente",
      "idx_contacto_cuenta",
      "idx_contrato_cuenta",
      "idx_contrato_año",
      "idx_descarga_cuenta_semana",
      "idx_descarga_contrato",
      "idx_propuesta_ae",
      "idx_propuesta_cuenta",
      "idx_propuesta_etapa",
      "idx_actividad_ae",
      "idx_actividad_propuesta",
      "idx_actividad_fecha",
      "idx_actividad_sentimiento",
      "idx_cuota_persona_semana",
      "idx_email_log_persona",
      "idx_evento_persona",
      "idx_crm_events_fecha",
      "idx_crm_docs_persona",
      "idx_crm_docs_source",
      "idx_crm_embed_doc",
    ];
    for (const idx of expected) {
      expect(indexes).toContain(idx);
    }
  });
});

describe("CRM Schema — persona", () => {
  it("allows CRUD on persona", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('p1', 'María', 'ae')`,
    ).run();
    const row = db
      .prepare("SELECT * FROM persona WHERE id = ?")
      .get("p1") as any;
    expect(row.nombre).toBe("María");
    expect(row.rol).toBe("ae");
    expect(row.activo).toBe(1);

    db.prepare(
      `UPDATE persona SET nombre = 'María López' WHERE id = 'p1'`,
    ).run();
    const updated = db
      .prepare("SELECT nombre FROM persona WHERE id = ?")
      .get("p1") as any;
    expect(updated.nombre).toBe("María López");

    db.prepare(`DELETE FROM persona WHERE id = 'p1'`).run();
    expect(
      db.prepare("SELECT * FROM persona WHERE id = ?").get("p1"),
    ).toBeUndefined();
  });

  it("rejects invalid rol via CHECK", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO persona (id, nombre, rol) VALUES ('bad', 'Bad', 'intern')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("accepts all valid roles", () => {
    for (const rol of ["ae", "gerente", "director", "vp"]) {
      expect(() =>
        db
          .prepare(`INSERT INTO persona (id, nombre, rol) VALUES (?, ?, ?)`)
          .run(`r-${rol}`, `Test ${rol}`, rol),
      ).not.toThrow();
    }
  });
});

describe("CRM Schema — cuenta", () => {
  it("allows CRUD on cuenta", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c1', 'Coca-Cola', 'directo', 'ae1')`,
    ).run();

    const row = db
      .prepare("SELECT * FROM cuenta WHERE id = ?")
      .get("c1") as any;
    expect(row.nombre).toBe("Coca-Cola");
    expect(row.tipo).toBe("directo");
    expect(row.fecha_creacion).toBeTruthy();
  });

  it("rejects invalid tipo via CHECK", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO cuenta (id, nombre, tipo) VALUES ('bad', 'X', 'hybrid')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("enforces FK on ae_id", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c1', 'X', 'directo', 'nonexistent')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("CRM Schema — contrato", () => {
  it("allows creating a contrato", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c1', 'Bimbo', 'directo', 'ae1')`,
    ).run();
    db.prepare(
      `INSERT INTO contrato (id, cuenta_id, año, monto_comprometido) VALUES ('ct1', 'c1', 2026, 25000000)`,
    ).run();

    const row = db
      .prepare("SELECT * FROM contrato WHERE id = ?")
      .get("ct1") as any;
    expect(row.monto_comprometido).toBe(25000000);
    expect(row.estatus).toBe("negociando");
  });

  it("rejects invalid estatus", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO cuenta (id, nombre, tipo, ae_id) VALUES ('c1', 'X', 'directo', 'ae1')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO contrato (id, cuenta_id, año, monto_comprometido, estatus) VALUES ('ct1', 'c1', 2026, 100, 'invalid')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe("CRM Schema — descarga (generated columns)", () => {
  it("computes gap as planificado - facturado", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO cuenta (id, nombre, tipo) VALUES ('c1', 'Test', 'directo')`,
    ).run();
    db.prepare(
      `INSERT INTO descarga (id, cuenta_id, semana, año, planificado, facturado) VALUES ('d1', 'c1', 1, 2026, 500000, 350000)`,
    ).run();

    const row = db
      .prepare("SELECT gap FROM descarga WHERE id = ?")
      .get("d1") as any;
    expect(row.gap).toBe(150000);
  });

  it("enforces semana range 1-52", () => {
    db.prepare(
      `INSERT INTO cuenta (id, nombre, tipo) VALUES ('c1', 'Test', 'directo')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO descarga (id, cuenta_id, semana, año) VALUES ('bad', 'c1', 0, 2026)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO descarga (id, cuenta_id, semana, año) VALUES ('bad', 'c1', 53, 2026)`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("enforces UNIQUE(cuenta_id, semana, año)", () => {
    db.prepare(
      `INSERT INTO cuenta (id, nombre, tipo) VALUES ('c1', 'Test', 'directo')`,
    ).run();
    db.prepare(
      `INSERT INTO descarga (id, cuenta_id, semana, año) VALUES ('d1', 'c1', 5, 2026)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO descarga (id, cuenta_id, semana, año) VALUES ('d2', 'c1', 5, 2026)`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });
});

describe("CRM Schema — propuesta (generated columns)", () => {
  it("computes es_mega based on valor_estimado > 15M", () => {
    db.prepare(
      `INSERT INTO propuesta (id, titulo, valor_estimado) VALUES ('p1', 'Small', 5000000)`,
    ).run();
    db.prepare(
      `INSERT INTO propuesta (id, titulo, valor_estimado) VALUES ('p2', 'Mega', 20000000)`,
    ).run();

    const small = db
      .prepare("SELECT es_mega FROM propuesta WHERE id = ?")
      .get("p1") as any;
    const mega = db
      .prepare("SELECT es_mega FROM propuesta WHERE id = ?")
      .get("p2") as any;
    expect(small.es_mega).toBe(0);
    expect(mega.es_mega).toBe(1);
  });

  it("rejects invalid etapa", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO propuesta (id, titulo, etapa) VALUES ('bad', 'X', 'flying')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("rejects invalid tipo_oportunidad", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO propuesta (id, titulo, tipo_oportunidad) VALUES ('bad', 'X', 'random')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("defaults etapa to en_preparacion", () => {
    db.prepare(
      `INSERT INTO propuesta (id, titulo) VALUES ('p1', 'Test')`,
    ).run();
    const row = db
      .prepare("SELECT etapa FROM propuesta WHERE id = ?")
      .get("p1") as any;
    expect(row.etapa).toBe("en_preparacion");
  });
});

describe("CRM Schema — cuota (generated columns)", () => {
  it("computes porcentaje as (logro / meta_total) * 100", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES ('q1', 'ae1', 'ae', 2026, 10, 1000000, 750000)`,
    ).run();

    const row = db
      .prepare("SELECT porcentaje FROM cuota WHERE id = ?")
      .get("q1") as any;
    expect(row.porcentaje).toBe(75);
  });

  it("returns 0 when meta_total is 0", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total, logro) VALUES ('q1', 'ae1', 'ae', 2026, 10, 0, 500)`,
    ).run();

    const row = db
      .prepare("SELECT porcentaje FROM cuota WHERE id = ?")
      .get("q1") as any;
    expect(row.porcentaje).toBe(0);
  });

  it("enforces UNIQUE(persona_id, año, semana)", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total) VALUES ('q1', 'ae1', 'ae', 2026, 10, 100)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO cuota (id, persona_id, rol, año, semana, meta_total) VALUES ('q2', 'ae1', 'ae', 2026, 10, 200)`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });
});

describe("CRM Schema — actividad", () => {
  it("allows creating an actividad with sentimiento", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO actividad (id, ae_id, tipo, resumen, sentimiento) VALUES ('a1', 'ae1', 'llamada', 'Llamada con cliente', 'positivo')`,
    ).run();

    const row = db
      .prepare("SELECT * FROM actividad WHERE id = ?")
      .get("a1") as any;
    expect(row.resumen).toBe("Llamada con cliente");
    expect(row.sentimiento).toBe("positivo");
  });

  it("rejects invalid tipo", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO actividad (id, tipo, resumen) VALUES ('bad', 'fax', 'Test')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("rejects invalid sentimiento", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO actividad (id, tipo, resumen, sentimiento) VALUES ('bad', 'llamada', 'T', 'happy')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("has Phase 8 columns: audio_ref, transcripcion, sentimiento_score, tipo_mensaje", () => {
    const cols = db.prepare("PRAGMA table_info(actividad)").all() as {
      name: string;
    }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("audio_ref");
    expect(colNames).toContain("transcripcion");
    expect(colNames).toContain("sentimiento_score");
    expect(colNames).toContain("tipo_mensaje");
  });

  it("stores audio_ref and transcripcion", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO actividad (id, ae_id, tipo, resumen, audio_ref, transcripcion, tipo_mensaje)
       VALUES ('a2', 'ae1', 'llamada', 'Voice note', 'attachments/audio-123.ogg', 'Hola, quiero hablar de la propuesta', 'audio')`,
    ).run();

    const row = db
      .prepare("SELECT * FROM actividad WHERE id = ?")
      .get("a2") as any;
    expect(row.audio_ref).toBe("attachments/audio-123.ogg");
    expect(row.transcripcion).toContain("propuesta");
    expect(row.tipo_mensaje).toBe("audio");
  });

  it("stores sentimiento_score as real", () => {
    db.prepare(
      `INSERT INTO actividad (id, tipo, resumen, sentimiento, sentimiento_score)
       VALUES ('a3', 'llamada', 'Test', 'positivo', 0.92)`,
    ).run();
    const row = db
      .prepare("SELECT sentimiento_score FROM actividad WHERE id = ?")
      .get("a3") as any;
    expect(row.sentimiento_score).toBeCloseTo(0.92, 2);
  });

  it("defaults tipo_mensaje to texto", () => {
    db.prepare(
      `INSERT INTO actividad (id, tipo, resumen) VALUES ('a4', 'llamada', 'Test')`,
    ).run();
    const row = db
      .prepare("SELECT tipo_mensaje FROM actividad WHERE id = ?")
      .get("a4") as any;
    expect(row.tipo_mensaje).toBe("texto");
  });
});

describe("CRM Schema — inventario", () => {
  it("allows creating inventory items", () => {
    db.prepare(
      `INSERT INTO inventario (id, medio, propiedad, formato, precio_referencia, precio_piso) VALUES ('inv1', 'tv_abierta', 'Canal Uno', 'spot_30s', 85000, 60000)`,
    ).run();

    const row = db
      .prepare("SELECT * FROM inventario WHERE id = ?")
      .get("inv1") as any;
    expect(row.medio).toBe("tv_abierta");
    expect(row.precio_piso).toBe(60000);
  });

  it("rejects invalid medio", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO inventario (id, medio, propiedad) VALUES ('bad', 'newspaper', 'X')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe("CRM Schema — email_log", () => {
  it("allows creating email log entries", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO email_log (id, persona_id, destinatario, asunto, tipo) VALUES ('e1', 'ae1', 'client@test.com', 'Seguimiento', 'seguimiento')`,
    ).run();

    const row = db
      .prepare("SELECT * FROM email_log WHERE id = ?")
      .get("e1") as any;
    expect(row.enviado).toBe(0);
    expect(row.tipo).toBe("seguimiento");
  });

  it("rejects invalid tipo", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO email_log (id, destinatario, asunto, tipo) VALUES ('bad', 'x@x.com', 'X', 'spam')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe("CRM Schema — evento_calendario", () => {
  it("allows creating calendar events", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO evento_calendario (id, persona_id, titulo, fecha_inicio, tipo) VALUES ('ev1', 'ae1', 'Seguimiento P&G', '2026-03-10T10:00:00', 'seguimiento')`,
    ).run();

    const row = db
      .prepare("SELECT * FROM evento_calendario WHERE id = ?")
      .get("ev1") as any;
    expect(row.titulo).toBe("Seguimiento P&G");
    expect(row.creado_por).toBe("agente");
  });

  it("rejects invalid tipo", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO evento_calendario (id, titulo, fecha_inicio, tipo) VALUES ('bad', 'X', '2026-01-01', 'party')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe("CRM Schema — contacto", () => {
  it("allows creating contacts", () => {
    db.prepare(
      `INSERT INTO cuenta (id, nombre, tipo) VALUES ('c1', 'Acme', 'directo')`,
    ).run();
    db.prepare(
      `INSERT INTO contacto (id, nombre, cuenta_id, rol, seniority) VALUES ('ct1', 'Juan Pérez', 'c1', 'decisor', 'senior')`,
    ).run();

    const row = db
      .prepare("SELECT * FROM contacto WHERE id = ?")
      .get("ct1") as any;
    expect(row.nombre).toBe("Juan Pérez");
    expect(row.rol).toBe("decisor");
  });

  it("rejects invalid rol", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO contacto (id, nombre, rol) VALUES ('bad', 'X', 'ceo')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("rejects invalid seniority", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO contacto (id, nombre, seniority) VALUES ('bad', 'X', 'intern')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe("CRM Schema — alerta_log", () => {
  it("allows creating alert log entries", () => {
    db.prepare(
      `INSERT INTO alerta_log (id, alerta_tipo, entidad_id, grupo_destino) VALUES ('al1', 'A01', 'prop1', 'ae1')`,
    ).run();

    const row = db
      .prepare("SELECT * FROM alerta_log WHERE id = ?")
      .get("al1") as any;
    expect(row.alerta_tipo).toBe("A01");
    expect(row.fecha_envio).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// crm_events
// ---------------------------------------------------------------------------

describe("CRM Schema — crm_events", () => {
  it("allows creating events", () => {
    db.prepare(
      `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, fecha_fin, prioridad) VALUES ('ev1', 'Copa del Mundo', 'deportivo', '2026-06-11', '2026-07-19', 'alta')`,
    ).run();

    const row = db
      .prepare("SELECT * FROM crm_events WHERE id = ?")
      .get("ev1") as any;
    expect(row.nombre).toBe("Copa del Mundo");
    expect(row.tipo).toBe("deportivo");
    expect(row.prioridad).toBe("alta");
  });

  it("rejects invalid tipo", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio) VALUES ('bad', 'X', 'random', '2026-01-01')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("rejects invalid prioridad", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, prioridad) VALUES ('bad', 'X', 'tentpole', '2026-01-01', 'urgente')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("accepts all valid tipos", () => {
    for (const tipo of ["tentpole", "deportivo", "estacional", "industria"]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio) VALUES (?, ?, ?, '2026-01-01')`,
          )
          .run(`ev-${tipo}`, `Event ${tipo}`, tipo),
      ).not.toThrow();
    }
  });

  it("defaults prioridad to media", () => {
    db.prepare(
      `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio) VALUES ('ev2', 'Buen Fin', 'estacional', '2026-11-20')`,
    ).run();
    const row = db
      .prepare("SELECT prioridad FROM crm_events WHERE id = ?")
      .get("ev2") as any;
    expect(row.prioridad).toBe("media");
  });

  it("stores JSON inventory fields", () => {
    const invTotal = JSON.stringify({ tv_abierta: 100, ctv: 50 });
    const invVendido = JSON.stringify({ tv_abierta: 60, ctv: 20 });
    db.prepare(
      `INSERT INTO crm_events (id, nombre, tipo, fecha_inicio, inventario_total, inventario_vendido) VALUES ('ev3', 'Liga MX', 'deportivo', '2026-07-01', ?, ?)`,
    ).run(invTotal, invVendido);

    const row = db
      .prepare(
        "SELECT inventario_total, inventario_vendido FROM crm_events WHERE id = ?",
      )
      .get("ev3") as any;
    expect(JSON.parse(row.inventario_total)).toEqual({
      tv_abierta: 100,
      ctv: 50,
    });
    expect(JSON.parse(row.inventario_vendido)).toEqual({
      tv_abierta: 60,
      ctv: 20,
    });
  });
});

// ---------------------------------------------------------------------------
// crm_documents + crm_embeddings (RAG)
// ---------------------------------------------------------------------------

describe("CRM Schema — crm_documents", () => {
  it("allows creating documents", () => {
    db.prepare(
      `INSERT INTO persona (id, nombre, rol) VALUES ('ae1', 'AE', 'ae')`,
    ).run();
    db.prepare(
      `INSERT INTO crm_documents (id, source, persona_id, titulo, tipo_doc) VALUES ('doc1', 'drive', 'ae1', 'Propuesta Q3', 'pdf')`,
    ).run();

    const row = db
      .prepare("SELECT * FROM crm_documents WHERE id = ?")
      .get("doc1") as any;
    expect(row.source).toBe("drive");
    expect(row.titulo).toBe("Propuesta Q3");
    expect(row.fecha_sync).toBeTruthy();
  });

  it("rejects invalid source", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO crm_documents (id, source, titulo) VALUES ('bad', 'ftp', 'X')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("accepts all valid sources", () => {
    for (const source of ["drive", "email", "manual"]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO crm_documents (id, source, titulo) VALUES (?, ?, 'Test')`,
          )
          .run(`doc-${source}`, source),
      ).not.toThrow();
    }
  });

  it("enforces FK on persona_id", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO crm_documents (id, source, persona_id, titulo) VALUES ('bad', 'drive', 'ghost', 'X')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("CRM Schema — crm_embeddings", () => {
  it("allows creating embeddings linked to documents", () => {
    db.prepare(
      `INSERT INTO crm_documents (id, source, titulo) VALUES ('doc1', 'manual', 'Test Doc')`,
    ).run();
    db.prepare(
      `INSERT INTO crm_embeddings (id, document_id, chunk_index, contenido) VALUES ('emb1', 'doc1', 0, 'First chunk of text')`,
    ).run();

    const row = db
      .prepare("SELECT * FROM crm_embeddings WHERE id = ?")
      .get("emb1") as any;
    expect(row.document_id).toBe("doc1");
    expect(row.chunk_index).toBe(0);
    expect(row.contenido).toBe("First chunk of text");
  });

  it("enforces UNIQUE(document_id, chunk_index)", () => {
    db.prepare(
      `INSERT INTO crm_documents (id, source, titulo) VALUES ('doc1', 'manual', 'Test')`,
    ).run();
    db.prepare(
      `INSERT INTO crm_embeddings (id, document_id, chunk_index, contenido) VALUES ('emb1', 'doc1', 0, 'Chunk A')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO crm_embeddings (id, document_id, chunk_index, contenido) VALUES ('emb2', 'doc1', 0, 'Chunk B')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("CASCADE deletes embeddings when document deleted", () => {
    db.prepare(
      `INSERT INTO crm_documents (id, source, titulo) VALUES ('doc1', 'manual', 'Test')`,
    ).run();
    db.prepare(
      `INSERT INTO crm_embeddings (id, document_id, chunk_index, contenido) VALUES ('emb1', 'doc1', 0, 'Chunk')`,
    ).run();
    db.prepare(
      `INSERT INTO crm_embeddings (id, document_id, chunk_index, contenido) VALUES ('emb2', 'doc1', 1, 'Chunk 2')`,
    ).run();

    db.prepare(`DELETE FROM crm_documents WHERE id = 'doc1'`).run();
    const count = db
      .prepare("SELECT COUNT(*) as c FROM crm_embeddings WHERE document_id = ?")
      .get("doc1") as any;
    expect(count.c).toBe(0);
  });

  it("enforces FK on document_id", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO crm_embeddings (id, document_id, chunk_index, contenido) VALUES ('bad', 'ghost', 0, 'X')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});
