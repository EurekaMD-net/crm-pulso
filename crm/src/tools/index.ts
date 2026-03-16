/**
 * CRM Tool Registry
 *
 * Defines all CRM tools in OpenAI function-calling JSON Schema format.
 * Provides role-based filtering and execution routing.
 */

import type { ToolDefinition, ToolCall } from "../inference-adapter.js";
import { getPersonById, getTeamIds, getFullTeamIds } from "../hierarchy.js";
import {
  registrar_actividad,
  crear_propuesta,
  actualizar_propuesta,
  cerrar_propuesta,
  actualizar_descarga,
} from "./registro.js";
import {
  consultar_pipeline,
  consultar_descarga,
  consultar_cuota,
  consultar_cuenta,
  consultar_cuentas,
  consultar_actividades,
  consultar_inventario,
} from "./consulta.js";
import {
  enviar_email_seguimiento,
  confirmar_envio_email,
  enviar_email_briefing,
} from "./email.js";
import { crear_evento_calendario, consultar_agenda } from "./calendar.js";
import { establecer_recordatorio } from "./seguimiento.js";
import { consultar_eventos, consultar_inventario_evento } from "./eventos.js";
import { buscar_documentos } from "./rag.js";
import { buscar_emails, leer_email, crear_borrador_email } from "./gmail.js";
import {
  listar_archivos_drive,
  leer_archivo_drive,
  crear_documento_drive,
} from "./drive.js";
import { buscar_web } from "./web-search.js";
import { analizar_winloss, analizar_tendencias } from "./analytics.js";
import { recomendar_crosssell } from "./crosssell.js";
import { generar_link_dashboard } from "./dashboard.js";
import { ejecutar_swarm } from "./swarm.js";
import { consultar_resumen_dia } from "./reflexion.js";
import { consultar_sentimiento_equipo } from "./sentiment.js";
import { generar_briefing } from "./briefing.js";
import {
  guardar_observacion,
  buscar_memoria,
  reflexionar_memoria,
} from "./memoria.js";
import {
  registrar_relacion_ejecutiva,
  registrar_interaccion_ejecutiva,
  consultar_salud_relaciones,
  consultar_historial_relacion,
  registrar_hito,
  consultar_hitos_proximos,
  actualizar_notas_estrategicas,
} from "./relaciones.js";
import {
  solicitar_cuenta,
  solicitar_contacto,
  aprobar_registro,
  rechazar_registro,
  consultar_pendientes,
  impugnar_registro,
} from "./aprobaciones.js";
import {
  consultar_insights,
  actuar_insight,
  consultar_insights_equipo,
} from "./insight-tools.js";

// ---------------------------------------------------------------------------
// Tool context — passed to every tool handler
// ---------------------------------------------------------------------------

export interface ToolContext {
  persona_id: string;
  rol: "ae" | "gerente" | "director" | "vp";
  team_ids: string[]; // direct report IDs
  full_team_ids: string[]; // all descendant IDs
}

export function buildToolContext(personaId: string): ToolContext | null {
  const persona = getPersonById(personaId);
  if (!persona) return null;
  return {
    persona_id: persona.id,
    rol: persona.rol,
    team_ids: getTeamIds(persona.id),
    full_team_ids: getFullTeamIds(persona.id),
  };
}

// ---------------------------------------------------------------------------
// Tool handler type
// ---------------------------------------------------------------------------

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => string | Promise<string>;

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

const TOOL_REGISTRAR_ACTIVIDAD: ToolDefinition = {
  type: "function",
  function: {
    name: "registrar_actividad",
    description:
      "Registra una interacción con un cliente (llamada, reunión, comida, etc). Usa esto cada vez que el Ejecutivo describe contacto con un cliente.",
    parameters: {
      type: "object",
      properties: {
        cuenta_nombre: {
          type: "string",
          description: "Nombre de la cuenta/cliente",
        },
        tipo: {
          type: "string",
          enum: [
            "llamada",
            "whatsapp",
            "comida",
            "email",
            "reunion",
            "visita",
            "envio_propuesta",
            "otro",
          ],
          description: "Tipo de interacción",
        },
        resumen: { type: "string", description: "Resumen de la interacción" },
        sentimiento: {
          type: "string",
          enum: ["positivo", "neutral", "negativo", "urgente"],
          description: "Sentimiento de la interacción",
        },
        propuesta_titulo: {
          type: "string",
          description: "Título de la propuesta relacionada (opcional)",
        },
        siguiente_accion: {
          type: "string",
          description: "Siguiente acción a tomar (opcional)",
        },
        fecha_siguiente_accion: {
          type: "string",
          description: "Fecha ISO de la siguiente acción (opcional)",
        },
      },
      required: ["cuenta_nombre", "tipo", "resumen"],
    },
  },
};

const TOOL_CREAR_PROPUESTA: ToolDefinition = {
  type: "function",
  function: {
    name: "crear_propuesta",
    description: "Crea una nueva propuesta comercial para un cliente.",
    parameters: {
      type: "object",
      properties: {
        cuenta_nombre: { type: "string", description: "Nombre de la cuenta" },
        titulo: { type: "string", description: "Título de la propuesta" },
        valor_estimado: {
          type: "number",
          description: "Valor estimado en MXN",
        },
        tipo_oportunidad: {
          type: "string",
          enum: [
            "estacional",
            "lanzamiento",
            "reforzamiento",
            "evento_especial",
            "tentpole",
            "prospeccion",
          ],
        },
        gancho_temporal: {
          type: "string",
          description: "Evento temporal (Día de las Madres, Buen Fin, etc.)",
        },
        fecha_vuelo_inicio: {
          type: "string",
          description: "Fecha inicio del vuelo (ISO)",
        },
        fecha_vuelo_fin: {
          type: "string",
          description: "Fecha fin del vuelo (ISO)",
        },
        medios: {
          type: "string",
          description:
            "JSON con desglose por medio: {tv_abierta, ctv, radio, digital}",
        },
      },
      required: ["cuenta_nombre", "titulo", "valor_estimado"],
    },
  },
};

const TOOL_ACTUALIZAR_PROPUESTA: ToolDefinition = {
  type: "function",
  function: {
    name: "actualizar_propuesta",
    description: "Actualiza el estado o datos de una propuesta existente.",
    parameters: {
      type: "object",
      properties: {
        propuesta_titulo: {
          type: "string",
          description: "Título de la propuesta a actualizar",
        },
        cuenta_nombre: {
          type: "string",
          description: "Nombre de la cuenta (para desambiguar)",
        },
        etapa: {
          type: "string",
          enum: [
            "en_preparacion",
            "enviada",
            "en_discusion",
            "en_negociacion",
            "confirmada_verbal",
            "orden_recibida",
            "en_ejecucion",
            "completada",
            "perdida",
            "cancelada",
          ],
        },
        valor_estimado: {
          type: "number",
          description: "Nuevo valor estimado en MXN",
        },
        notas: { type: "string", description: "Notas adicionales" },
        razon_perdida: {
          type: "string",
          description: "Razón (requerida si etapa = perdida o cancelada)",
        },
      },
      required: ["propuesta_titulo"],
    },
  },
};

const TOOL_CERRAR_PROPUESTA: ToolDefinition = {
  type: "function",
  function: {
    name: "cerrar_propuesta",
    description: "Marca una propuesta como completada, perdida o cancelada.",
    parameters: {
      type: "object",
      properties: {
        propuesta_titulo: {
          type: "string",
          description: "Título de la propuesta",
        },
        cuenta_nombre: { type: "string", description: "Nombre de la cuenta" },
        resultado: {
          type: "string",
          enum: ["completada", "perdida", "cancelada"],
        },
        razon: {
          type: "string",
          description: "Razón del cierre (requerida para perdida/cancelada)",
        },
      },
      required: ["propuesta_titulo", "resultado"],
    },
  },
};

const TOOL_ACTUALIZAR_DESCARGA: ToolDefinition = {
  type: "function",
  function: {
    name: "actualizar_descarga",
    description:
      "Agrega notas cualitativas sobre la descarga (facturación) esperada de la semana actual.",
    parameters: {
      type: "object",
      properties: {
        cuenta_nombre: { type: "string", description: "Nombre de la cuenta" },
        semana: { type: "number", description: "Número de semana (1-52)" },
        notas_ae: {
          type: "string",
          description: "Notas del Ejecutivo sobre facturación esperada",
        },
      },
      required: ["cuenta_nombre", "notas_ae"],
    },
  },
};

const TOOL_CONSULTAR_PIPELINE: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_pipeline",
    description:
      "Consulta el pipeline de propuestas filtrado por etapa, cuenta, o tipo de oportunidad.",
    parameters: {
      type: "object",
      properties: {
        etapa: { type: "string", description: "Filtrar por etapa" },
        cuenta_nombre: { type: "string", description: "Filtrar por cuenta" },
        tipo_oportunidad: { type: "string", description: "Filtrar por tipo" },
        solo_estancadas: {
          type: "boolean",
          description: "Solo propuestas con >7 días sin actividad",
        },
      },
    },
  },
};

const TOOL_CONSULTAR_DESCARGA: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_descarga",
    description:
      "Consulta el avance de descarga (facturación) vs plan semanal.",
    parameters: {
      type: "object",
      properties: {
        cuenta_nombre: {
          type: "string",
          description: "Filtrar por cuenta (opcional)",
        },
        semana: {
          type: "number",
          description: "Semana específica (opcional, default: actual)",
        },
        año: { type: "number", description: "Año (default: actual)" },
      },
    },
  },
};

const TOOL_CONSULTAR_CUOTA: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_cuota",
    description:
      "Consulta el avance de cuota para la semana actual o un rango de semanas.",
    parameters: {
      type: "object",
      properties: {
        semana: { type: "number", description: "Semana específica (opcional)" },
        persona_nombre: {
          type: "string",
          description: "Filtrar por persona (solo gerentes+)",
        },
      },
    },
  },
};

const TOOL_CONSULTAR_CUENTA: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_cuenta",
    description:
      "Consulta el detalle completo de una cuenta: contactos, propuestas activas, contrato, descargas.",
    parameters: {
      type: "object",
      properties: {
        cuenta_nombre: { type: "string", description: "Nombre de la cuenta" },
      },
      required: ["cuenta_nombre"],
    },
  },
};

const TOOL_CONSULTAR_CUENTAS: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_cuentas",
    description:
      "Lista todas las cuentas (clientes/anunciantes) con su agencia de medios, holding, ejecutivo asignado, y conteo de contactos cliente vs agencia.\n\n" +
      "USAR CUANDO:\n" +
      "- Necesitas una vision general de todas las cuentas\n" +
      "- Quieres saber que cuentas trabajan con que agencia\n" +
      "- Buscas cuentas por vertical o agencia\n" +
      "- El usuario pregunta por 'las agencias', 'con que agencias trabajamos', 'listado de cuentas'",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

const TOOL_CONSULTAR_ACTIVIDADES: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_actividades",
    description: "Consulta actividades recientes para una cuenta o propuesta.",
    parameters: {
      type: "object",
      properties: {
        cuenta_nombre: { type: "string", description: "Filtrar por cuenta" },
        propuesta_titulo: {
          type: "string",
          description: "Filtrar por propuesta",
        },
        limite: {
          type: "number",
          description: "Número máximo de resultados (default 20)",
        },
      },
    },
  },
};

const TOOL_CONSULTAR_INVENTARIO: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_inventario",
    description: "Consulta la tarjeta de tarifas: medios, formatos, precios.",
    parameters: {
      type: "object",
      properties: {
        medio: {
          type: "string",
          enum: ["tv_abierta", "ctv", "radio", "digital"],
          description: "Filtrar por medio",
        },
        propiedad: {
          type: "string",
          description: "Filtrar por propiedad (Canal Uno, etc.)",
        },
      },
    },
  },
};

const TOOL_ENVIAR_EMAIL_SEGUIMIENTO: ToolDefinition = {
  type: "function",
  function: {
    name: "enviar_email_seguimiento",
    description:
      "Redacta y guarda un email de seguimiento. El Ejecutivo debe confirmar antes de enviar.",
    parameters: {
      type: "object",
      properties: {
        contacto_id: {
          type: "string",
          description: "ID del contacto destinatario",
        },
        propuesta_id: {
          type: "string",
          description: "ID de la propuesta relacionada (opcional)",
        },
        asunto: { type: "string", description: "Línea de asunto del email" },
        cuerpo: { type: "string", description: "Cuerpo del email" },
        programar_para: {
          type: "string",
          description: "Fecha/hora ISO para envío diferido (opcional)",
        },
      },
      required: ["contacto_id", "asunto", "cuerpo"],
    },
  },
};

const TOOL_CONFIRMAR_ENVIO_EMAIL: ToolDefinition = {
  type: "function",
  function: {
    name: "confirmar_envio_email",
    description:
      "Confirma y envía un email previamente guardado como borrador.",
    parameters: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "ID del email en email_log" },
      },
      required: ["email_id"],
    },
  },
};

const TOOL_ENVIAR_EMAIL_BRIEFING: ToolDefinition = {
  type: "function",
  function: {
    name: "enviar_email_briefing",
    description:
      "Envía un briefing semanal por email al gerente y opcionalmente a su equipo.",
    parameters: {
      type: "object",
      properties: {
        asunto: { type: "string", description: "Asunto del briefing" },
        cuerpo_html: {
          type: "string",
          description: "Cuerpo HTML del briefing",
        },
        incluir_equipo: {
          type: "boolean",
          description: "Enviar también al equipo",
        },
      },
      required: ["asunto", "cuerpo_html"],
    },
  },
};

const TOOL_CREAR_EVENTO_CALENDARIO: ToolDefinition = {
  type: "function",
  function: {
    name: "crear_evento_calendario",
    description:
      "Crea un evento en el calendario. Usar cuando se identifica una reunión, seguimiento, o fecha límite.",
    parameters: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Título del evento" },
        fecha_inicio: {
          type: "string",
          description: "Fecha/hora ISO del inicio",
        },
        duracion_minutos: {
          type: "number",
          description: "Duración en minutos (default 30)",
        },
        descripcion: { type: "string", description: "Notas o contexto" },
        tipo: {
          type: "string",
          enum: ["seguimiento", "reunion", "tentpole", "deadline", "briefing"],
        },
        propuesta_id: {
          type: "string",
          description: "Propuesta relacionada (opcional)",
        },
        cuenta_id: {
          type: "string",
          description: "Cuenta relacionada (opcional)",
        },
      },
      required: ["titulo", "fecha_inicio"],
    },
  },
};

const TOOL_CONSULTAR_AGENDA: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_agenda",
    description: "Consulta los eventos del calendario para hoy o esta semana.",
    parameters: {
      type: "object",
      properties: {
        rango: {
          type: "string",
          enum: ["hoy", "mañana", "esta_semana", "proxima_semana"],
          description: "Período a consultar",
        },
      },
      required: ["rango"],
    },
  },
};

const TOOL_ESTABLECER_RECORDATORIO: ToolDefinition = {
  type: "function",
  function: {
    name: "establecer_recordatorio",
    description:
      "Establece un recordatorio para una fecha futura. Crea un evento de calendario tipo seguimiento.",
    parameters: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Qué recordar" },
        fecha: {
          type: "string",
          description: "Fecha/hora ISO del recordatorio",
        },
        cuenta_nombre: {
          type: "string",
          description: "Cuenta relacionada (opcional)",
        },
        propuesta_titulo: {
          type: "string",
          description: "Propuesta relacionada (opcional)",
        },
      },
      required: ["titulo", "fecha"],
    },
  },
};

const TOOL_CONSULTAR_EVENTOS: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_eventos",
    description:
      "Consulta eventos proximos (deportivos, tentpoles, estacionales, industria) y su inventario disponible.",
    parameters: {
      type: "object",
      properties: {
        tipo: {
          type: "string",
          enum: ["tentpole", "deportivo", "estacional", "industria"],
          description: "Filtrar por tipo de evento",
        },
        dias_adelante: {
          type: "number",
          description: "Dias a futuro (default 90)",
        },
      },
    },
  },
};

const TOOL_CONSULTAR_INVENTARIO_EVENTO: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_inventario_evento",
    description:
      "Consulta el inventario detallado de un evento especifico: disponibilidad por medio, meta de ingresos.",
    parameters: {
      type: "object",
      properties: {
        evento_nombre: { type: "string", description: "Nombre del evento" },
      },
      required: ["evento_nombre"],
    },
  },
};

const TOOL_BUSCAR_EMAILS: ToolDefinition = {
  type: "function",
  function: {
    name: "buscar_emails",
    description: "Busca emails en la bandeja de entrada de Gmail.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Consulta de busqueda (formato Gmail: from:, subject:, etc.)",
        },
        limite: {
          type: "number",
          description: "Numero maximo de resultados (default 10)",
        },
      },
    },
  },
};

const TOOL_LEER_EMAIL: ToolDefinition = {
  type: "function",
  function: {
    name: "leer_email",
    description: "Lee el contenido completo de un email por su ID.",
    parameters: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "ID del email (obtenido de buscar_emails)",
        },
      },
      required: ["email_id"],
    },
  },
};

const TOOL_CREAR_BORRADOR_EMAIL: ToolDefinition = {
  type: "function",
  function: {
    name: "crear_borrador_email",
    description: "Crea un borrador de email en Gmail.",
    parameters: {
      type: "object",
      properties: {
        destinatario: { type: "string", description: "Email del destinatario" },
        asunto: { type: "string", description: "Asunto del email" },
        cuerpo: { type: "string", description: "Cuerpo del email" },
      },
      required: ["destinatario", "asunto", "cuerpo"],
    },
  },
};

const TOOL_LISTAR_ARCHIVOS_DRIVE: ToolDefinition = {
  type: "function",
  function: {
    name: "listar_archivos_drive",
    description: "Lista archivos en Google Drive con busqueda opcional.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto de busqueda (opcional)" },
        carpeta_id: {
          type: "string",
          description: "ID de carpeta para filtrar (opcional)",
        },
        limite: {
          type: "number",
          description: "Numero maximo de resultados (default 20)",
        },
      },
    },
  },
};

const TOOL_LEER_ARCHIVO_DRIVE: ToolDefinition = {
  type: "function",
  function: {
    name: "leer_archivo_drive",
    description:
      "Lee el contenido de un archivo de Google Drive (truncado a 50KB).",
    parameters: {
      type: "object",
      properties: {
        archivo_id: {
          type: "string",
          description: "ID del archivo (obtenido de listar_archivos_drive)",
        },
      },
      required: ["archivo_id"],
    },
  },
};

const TOOL_CREAR_DOCUMENTO_DRIVE: ToolDefinition = {
  type: "function",
  function: {
    name: "crear_documento_drive",
    description:
      "Crea un nuevo documento de Google (Doc, Hoja de Calculo, o Presentacion) en el Drive del usuario.\n\n" +
      "USAR CUANDO:\n" +
      "- El usuario pide crear un documento, reporte, presentacion, o spreadsheet\n" +
      "- Necesitas preparar un entregable formal (propuesta, briefing, analisis)\n\n" +
      "TIPOS:\n" +
      "- 'documento' — Google Docs (reportes, propuestas, minutas). Contenido: texto plano\n" +
      "- 'hoja_de_calculo' — Google Sheets (datos, comparativas, presupuestos). Contenido: primera linea = encabezados, resto = datos. Separa columnas con TAB o coma. Ejemplo: 'Cuenta\\tValor\\tEtapa\\nCoca-Cola\\t$15M\\tEn negociacion'. Encabezados se formatean automaticamente en negritas con fondo gris\n" +
      "- 'presentacion' — Google Slides (decks, presentaciones a clientes). Contenido: secciones separadas por doble salto de linea. Primera linea de cada seccion = titulo del slide, resto = cuerpo",
    parameters: {
      type: "object",
      properties: {
        nombre: {
          type: "string",
          description: "Nombre del documento",
        },
        tipo: {
          type: "string",
          enum: ["documento", "hoja_de_calculo", "presentacion"],
          description: "Tipo de documento a crear. Default: documento",
        },
        contenido: {
          type: "string",
          description:
            "Contenido inicial. Para documento: texto plano. Para hoja_de_calculo: lineas separadas por \\n, columnas por TAB (\\t) — primera linea son los encabezados. Para presentacion: secciones separadas por \\n\\n, primera linea = titulo del slide.",
        },
        carpeta_id: {
          type: "string",
          description: "ID de carpeta destino en Drive (opcional)",
        },
      },
      required: ["nombre"],
    },
  },
};

const TOOL_BUSCAR_DOCUMENTOS: ToolDefinition = {
  type: "function",
  function: {
    name: "buscar_documentos",
    description:
      "Busca en documentos sincronizados (Drive, email) usando busqueda semantica.",
    parameters: {
      type: "object",
      properties: {
        consulta: {
          type: "string",
          description: "Texto de busqueda semantica",
        },
        limite: {
          type: "number",
          description: "Numero maximo de resultados (default 5)",
        },
        tipo_doc: {
          type: "string",
          description:
            "Filtrar por tipo (google_doc, google_sheet, text, email)",
        },
      },
      required: ["consulta"],
    },
  },
};

const TOOL_BUSCAR_WEB: ToolDefinition = {
  type: "function",
  function: {
    name: "buscar_web",
    description:
      "Busca informacion en internet en tiempo real (noticias, datos de mercado, empresas, tendencias).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto de busqueda" },
        limite: {
          type: "number",
          description: "Maximo resultados (default 5, max 10)",
        },
      },
      required: ["query"],
    },
  },
};

const TOOL_ANALIZAR_WINLOSS: ToolDefinition = {
  type: "function",
  function: {
    name: "analizar_winloss",
    description:
      "Analiza patrones de propuestas ganadas/perdidas en un periodo. Tasas de conversion, razones de perdida, desglose por dimension.",
    parameters: {
      type: "object",
      properties: {
        periodo_dias: {
          type: "number",
          description: "Periodo de analisis en dias (default 90)",
        },
        agrupar_por: {
          type: "string",
          enum: ["tipo_oportunidad", "vertical", "ejecutivo", "cuenta"],
          description: "Dimension de agrupacion",
        },
        cuenta_nombre: {
          type: "string",
          description: "Filtrar por cuenta (opcional)",
        },
        solo_mega: { type: "boolean", description: "Solo mega-deals (>$15M)" },
      },
    },
  },
};

const TOOL_ANALIZAR_TENDENCIAS: ToolDefinition = {
  type: "function",
  function: {
    name: "analizar_tendencias",
    description:
      "Analiza tendencias semanales de rendimiento: cuota, actividad, pipeline, o sentimiento.",
    parameters: {
      type: "object",
      properties: {
        periodo_semanas: {
          type: "number",
          description: "Periodo en semanas (default 12)",
        },
        metrica: {
          type: "string",
          enum: ["cuota", "actividad", "pipeline", "sentimiento"],
          description: "Metrica a analizar",
        },
        persona_nombre: {
          type: "string",
          description: "Filtrar por persona (solo gerentes+)",
        },
      },
    },
  },
};

const TOOL_RECOMENDAR_CROSSSELL: ToolDefinition = {
  type: "function",
  function: {
    name: "recomendar_crosssell",
    description:
      "Genera recomendaciones de cross-sell/upsell para una cuenta basado en su historial y comparacion con cuentas similares.",
    parameters: {
      type: "object",
      properties: {
        cuenta_nombre: {
          type: "string",
          description: "Nombre de la cuenta a analizar",
        },
        limite: {
          type: "number",
          description: "Maximo de recomendaciones (default 5)",
        },
      },
      required: ["cuenta_nombre"],
    },
  },
};

const TOOL_GENERAR_LINK_DASHBOARD: ToolDefinition = {
  type: "function",
  function: {
    name: "generar_link_dashboard",
    description:
      "Genera un enlace personalizado al dashboard web del CRM con datos en tiempo real (pipeline, cuota, descarga, actividad). El enlace incluye autenticacion y es valido por 30 dias.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

const TOOL_CONSULTAR_RESUMEN_DIA: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_resumen_dia",
    description:
      "Resume el dia completo: actividades registradas, propuestas que avanzaron, acciones pendientes/vencidas, propuestas estancadas, y avance de cuota. Usa al final del dia para el cierre diario.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

const TOOL_CONSULTAR_SENTIMIENTO_EQUIPO: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_sentimiento_equipo",
    description:
      "Consulta la distribucion de sentimiento del equipo en un periodo. Muestra positivo/neutral/negativo/urgente por Ejecutivo, tendencia vs periodo anterior, y alertas de Ejecutivos con alto % negativo.",
    parameters: {
      type: "object",
      properties: {
        dias: {
          type: "number",
          description: "Dias de historia a analizar (default 7)",
        },
      },
    },
  },
};

const TOOL_EJECUTAR_SWARM: ToolDefinition = {
  type: "function",
  function: {
    name: "ejecutar_swarm",
    description:
      "Ejecuta un análisis multi-dimensional en paralelo. Combina 4-6 consultas en una sola llamada para preguntas complejas. Recetas: resumen_semanal_equipo (gerente: pipeline+cuota+actividad+sentimiento), diagnostico_persona (gerente/director: análisis profundo de un ejecutivo), comparar_equipo (gerente/director: comparativa lado a lado), resumen_ejecutivo (vp: visión organizacional completa), diagnostico_medio (director/vp: rendimiento por tv_abierta/ctv/radio/digital).",
    parameters: {
      type: "object",
      properties: {
        receta: {
          type: "string",
          enum: [
            "resumen_semanal_equipo",
            "diagnostico_persona",
            "comparar_equipo",
            "resumen_ejecutivo",
            "diagnostico_medio",
          ],
          description: "Nombre de la receta a ejecutar",
        },
        persona_nombre: {
          type: "string",
          description: "Nombre de persona (requerido para diagnostico_persona)",
        },
        periodo_dias: {
          type: "number",
          description: "Override del periodo de análisis en días (opcional)",
        },
      },
      required: ["receta"],
    },
  },
};

const TOOL_GENERAR_BRIEFING: ToolDefinition = {
  type: "function",
  function: {
    name: "generar_briefing",
    description:
      "Genera un briefing agregado segun tu rol. Incluye carry-over, cuentas sin contacto, path-to-close, sentimiento, compliance, mega-deals, y revenue at risk. No requiere parametros — todo se infiere de tu contexto.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

const TOOL_GUARDAR_OBSERVACION: ToolDefinition = {
  type: "function",
  function: {
    name: "guardar_observacion",
    description:
      "Guarda una observacion o aprendizaje en la memoria a largo plazo para futuras consultas.\n\n" +
      "USAR CUANDO:\n" +
      "- Descubres algo importante durante una interaccion con un cliente (preferencia, objecion recurrente, estilo de negociacion)\n" +
      "- Una estrategia de venta funciono o fallo y quieres recordar por que\n" +
      "- Identificas un patron de comportamiento de una cuenta o contacto\n\n" +
      "NO USAR CUANDO:\n" +
      "- La informacion ya queda registrada en una actividad (registrar_actividad la captura automaticamente)\n" +
      "- Es un dato transaccional (monto, fecha) que pertenece a propuesta o contrato\n\n" +
      "TIPS:\n" +
      "- Se especifico y accionable: 'Coca-Cola prefiere propuestas con desglose por trimestre, no anual'\n" +
      "- Incluye contexto: que paso, por que importa, que hacer diferente la proxima vez",
    parameters: {
      type: "object",
      properties: {
        contenido: {
          type: "string",
          description:
            "La observacion o aprendizaje a guardar. Debe ser especifico, accionable y auto-contenido.",
        },
        banco: {
          type: "string",
          enum: ["ventas", "cuentas", "equipo"],
          description:
            "En que banco guardar. Default: ventas. 'cuentas' para inteligencia de cuentas, 'equipo' para patrones de gestion (solo gerentes+).",
        },
        etiquetas: {
          type: "array",
          items: { type: "string" },
          description:
            'Etiquetas opcionales para categorizar. Ejemplos: ["objecion","precio"], ["cierre","tentpole"].',
        },
      },
      required: ["contenido"],
    },
  },
};

const TOOL_BUSCAR_MEMORIA: ToolDefinition = {
  type: "function",
  function: {
    name: "buscar_memoria",
    description:
      "Busca en la memoria a largo plazo observaciones y aprendizajes pasados relevantes a una consulta.\n\n" +
      "USAR CUANDO:\n" +
      "- Necesitas recordar como se manejo una objecion similar en el pasado\n" +
      "- Quieres consultar preferencias conocidas de un cliente o contacto\n" +
      "- Buscas patrones de lo que ha funcionado en cuentas similares\n\n" +
      "NO USAR CUANDO:\n" +
      "- La informacion esta en el CRM (usa consultar_cuenta, consultar_actividades, etc.)\n" +
      "- Necesitas datos en tiempo real (usa buscar_web)\n\n" +
      "BANCOS:\n" +
      "- 'ventas' — Patrones de venta, objeciones, cierres, preferencias de clientes\n" +
      "- 'cuentas' — Inteligencia de cuentas, relaciones, stakeholders\n" +
      "- 'equipo' — Patrones de rendimiento, coaching (solo gerentes+)",
    parameters: {
      type: "object",
      properties: {
        consulta: {
          type: "string",
          description:
            "Consulta de busqueda en lenguaje natural. Se especifico — 'manejo objecion precio TV' funciona mejor que 'objeciones'.",
        },
        banco: {
          type: "string",
          enum: ["ventas", "cuentas", "equipo"],
          description: "En que banco buscar. Default: ventas.",
        },
        limite: {
          type: "number",
          description: "Maximo de memorias a retornar (1-20). Default: 5.",
        },
      },
      required: ["consulta"],
    },
  },
};

const TOOL_REFLEXIONAR_MEMORIA: ToolDefinition = {
  type: "function",
  function: {
    name: "reflexionar_memoria",
    description:
      "Sintetiza una reflexion a partir de memorias almacenadas sobre un tema. Retorna un resumen coherente en vez de memorias individuales.\n\n" +
      "USAR CUANDO:\n" +
      "- Necesitas una vision general de experiencias pasadas con un tema\n" +
      "- Quieres entender patrones en multiples observaciones relacionadas\n" +
      "- Necesitas contexto estrategico (ej: 'Que ha funcionado para cerrar cuentas de telecomunicaciones?')\n\n" +
      "NO USAR CUANDO:\n" +
      "- Necesitas memorias individuales especificas (usa buscar_memoria)\n" +
      "- Necesitas datos cuantitativos (usa analizar_winloss o analizar_tendencias)",
    parameters: {
      type: "object",
      properties: {
        tema: {
          type: "string",
          description:
            "Tema o pregunta sobre la cual reflexionar. Se especifico para mejor sintesis.",
        },
        banco: {
          type: "string",
          enum: ["ventas", "cuentas", "equipo"],
          description: "En que banco reflexionar. Default: ventas.",
        },
      },
      required: ["tema"],
    },
  },
};

const TOOL_REGISTRAR_RELACION_EJECUTIVA: ToolDefinition = {
  type: "function",
  function: {
    name: "registrar_relacion_ejecutiva",
    description:
      "Inicia el rastreo de una relacion ejecutiva con un contacto clave.\n\n" +
      "USAR CUANDO:\n" +
      "- Quieres monitorear la salud de una relacion con un decisor, director de marketing, o contacto estrategico\n" +
      "- Despues de una comida o reunion importante con alguien que vale la pena rastrear a largo plazo\n\n" +
      "NO USAR CUANDO:\n" +
      "- El contacto ya esta siendo rastreado (el sistema te avisara)\n" +
      "- Es un contacto operativo de bajo nivel — reserva para relaciones estrategicas",
    parameters: {
      type: "object",
      properties: {
        contacto_nombre: {
          type: "string",
          description: "Nombre del contacto ejecutivo",
        },
        tipo: {
          type: "string",
          enum: ["cliente", "agencia", "industria", "interna"],
          description: "Tipo de relacion",
        },
        importancia: {
          type: "string",
          enum: ["critica", "alta", "media", "baja"],
          description: "Nivel de importancia estrategica",
        },
        notas_estrategicas: {
          type: "string",
          description: "Notas de estrategia para esta relacion (opcional)",
        },
      },
      required: ["contacto_nombre"],
    },
  },
};

const TOOL_REGISTRAR_INTERACCION_EJECUTIVA: ToolDefinition = {
  type: "function",
  function: {
    name: "registrar_interaccion_ejecutiva",
    description:
      "Registra una interaccion ejecutiva (comida, reunion, evento, etc.) con un contacto rastreado.\n\n" +
      "USAR CUANDO:\n" +
      "- Tuviste una comida, reunion, o evento con un contacto ejecutivo rastreado\n" +
      "- Quieres actualizar el warmth score de la relacion con una nueva interaccion\n\n" +
      "NO USAR CUANDO:\n" +
      "- La relacion no ha sido registrada (usa registrar_relacion_ejecutiva primero)\n" +
      "- Es una actividad operativa de un AE (usa registrar_actividad)",
    parameters: {
      type: "object",
      properties: {
        contacto_nombre: { type: "string", description: "Nombre del contacto" },
        tipo: {
          type: "string",
          enum: [
            "llamada",
            "comida",
            "evento",
            "reunion",
            "email",
            "regalo",
            "presentacion",
            "otro",
          ],
        },
        resumen: { type: "string", description: "Resumen de la interaccion" },
        calidad: {
          type: "string",
          enum: ["excepcional", "buena", "normal", "superficial"],
          description: "Calidad de la interaccion",
        },
        lugar: { type: "string", description: "Lugar o contexto (opcional)" },
      },
      required: ["contacto_nombre", "resumen"],
    },
  },
};

const TOOL_CONSULTAR_SALUD_RELACIONES: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_salud_relaciones",
    description:
      "Muestra el estado de warmth de todas tus relaciones ejecutivas rastreadas, ordenadas por salud.\n\n" +
      "USAR CUANDO:\n" +
      "- Quieres ver que relaciones necesitan atencion (frias o congeladas)\n" +
      "- Antes de planear tu agenda semanal de relaciones\n" +
      "- Para una vista general del estado relacional con una cuenta especifica",
    parameters: {
      type: "object",
      properties: {
        filtro: {
          type: "string",
          enum: ["todas", "frias", "calientes"],
          description: "Filtrar por estado de warmth. Default: todas",
        },
        cuenta_nombre: {
          type: "string",
          description: "Filtrar por cuenta (opcional)",
        },
      },
    },
  },
};

const TOOL_CONSULTAR_HISTORIAL_RELACION: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_historial_relacion",
    description:
      "Historial completo de una relacion ejecutiva: interacciones, hitos, warmth detallado, notas estrategicas.\n\n" +
      "USAR CUANDO:\n" +
      "- Necesitas prepararte para una reunion con un contacto ejecutivo\n" +
      "- Quieres analizar la evolucion de una relacion\n" +
      "- Antes de tomar una decision estrategica sobre una cuenta clave",
    parameters: {
      type: "object",
      properties: {
        contacto_nombre: { type: "string", description: "Nombre del contacto" },
      },
      required: ["contacto_nombre"],
    },
  },
};

const TOOL_REGISTRAR_HITO: ToolDefinition = {
  type: "function",
  function: {
    name: "registrar_hito",
    description:
      "Registra un hito de un contacto ejecutivo (cumpleanos, ascenso, cambio de empresa, renovacion).\n\n" +
      "USAR CUANDO:\n" +
      "- Descubres el cumpleanos de un contacto clave\n" +
      "- Un contacto fue ascendido o cambio de empresa\n" +
      "- Hay una fecha de renovacion de contrato importante",
    parameters: {
      type: "object",
      properties: {
        contacto_nombre: { type: "string", description: "Nombre del contacto" },
        tipo: {
          type: "string",
          enum: [
            "cumpleanos",
            "ascenso",
            "cambio_empresa",
            "renovacion",
            "aniversario",
            "otro",
          ],
        },
        titulo: { type: "string", description: "Descripcion breve del hito" },
        fecha: {
          type: "string",
          description: "Fecha del hito (ISO: YYYY-MM-DD)",
        },
        recurrente: {
          type: "boolean",
          description: "Si se repite anualmente (ej: cumpleanos)",
        },
        notas: { type: "string", description: "Notas adicionales (opcional)" },
      },
      required: ["contacto_nombre", "titulo", "fecha"],
    },
  },
};

const TOOL_CONSULTAR_HITOS_PROXIMOS: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_hitos_proximos",
    description:
      "Muestra hitos proximos de contactos ejecutivos rastreados (cumpleanos, ascensos, renovaciones).\n\n" +
      "USAR CUANDO:\n" +
      "- Quieres planear gestos de goodwill para las proximas semanas\n" +
      "- Antes de un briefing semanal para mencionar fechas importantes",
    parameters: {
      type: "object",
      properties: {
        dias_adelante: {
          type: "number",
          description: "Dias a futuro (default 30, max 180)",
        },
      },
    },
  },
};

const TOOL_ACTUALIZAR_NOTAS_ESTRATEGICAS: ToolDefinition = {
  type: "function",
  function: {
    name: "actualizar_notas_estrategicas",
    description:
      "Actualiza las notas de estrategia para una relacion ejecutiva.\n\n" +
      "USAR CUANDO:\n" +
      "- Cambia la dinamica politica de una cuenta\n" +
      "- Quieres documentar una estrategia de acercamiento a largo plazo\n" +
      "- Despues de una reunion reveladora que cambia tu perspectiva sobre la relacion",
    parameters: {
      type: "object",
      properties: {
        contacto_nombre: { type: "string", description: "Nombre del contacto" },
        notas: {
          type: "string",
          description: "Notas de estrategia (reemplaza las anteriores)",
        },
      },
      required: ["contacto_nombre", "notas"],
    },
  },
};

// ---------------------------------------------------------------------------
// Approval workflow tools
// ---------------------------------------------------------------------------

const TOOL_SOLICITAR_CUENTA: ToolDefinition = {
  type: "function",
  function: {
    name: "solicitar_cuenta",
    description:
      "Solicita la creacion de una nueva cuenta (cliente/anunciante). Cada nivel debe asignar al nivel inferior:\n" +
      "- Ejecutivo: crea cuenta (ae_id = tu). Cadena: pendiente_gerente → pendiente_director → activo_en_revision → activo\n" +
      "- Gerente: debe asignar ejecutivo_nombre. Cadena: pendiente_director → activo_en_revision → activo\n" +
      "- Director: debe asignar gerente_nombre (el gerente luego asigna al ejecutivo). Cadena: pendiente_gerente → activo_en_revision → activo\n" +
      "- VP: debe asignar director_nombre (el director asigna gerente, gerente asigna ejecutivo). Cadena completa descendente\n\n" +
      "USAR CUANDO:\n" +
      "- Quieres registrar un nuevo cliente/anunciante en el CRM\n\n" +
      "NO USAR SI:\n" +
      "- La cuenta ya existe (usa consultar_cuentas para verificar primero)",
    parameters: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Nombre de la cuenta/empresa" },
        tipo: {
          type: "string",
          enum: ["directo", "agencia"],
          description: "Tipo de cuenta. Default: directo",
        },
        vertical: {
          type: "string",
          description: "Vertical/industria (opcional)",
        },
        holding_agencia: {
          type: "string",
          description: "Holding de agencia (ej. WPP, Publicis) (opcional)",
        },
        agencia_medios: {
          type: "string",
          description: "Agencia de medios que maneja la cuenta (opcional)",
        },
        notas: { type: "string", description: "Notas iniciales (opcional)" },
        ejecutivo_nombre: {
          type: "string",
          description:
            "Nombre del Ejecutivo que manejara la cuenta (requerido para gerentes)",
        },
        gerente_nombre: {
          type: "string",
          description:
            "Nombre del Gerente que supervisara la cuenta (requerido para directores)",
        },
        director_nombre: {
          type: "string",
          description:
            "Nombre del Director que supervisara la cuenta (requerido para VP)",
        },
      },
      required: ["nombre"],
    },
  },
};

const TOOL_SOLICITAR_CONTACTO: ToolDefinition = {
  type: "function",
  function: {
    name: "solicitar_contacto",
    description:
      "Solicita la creacion de un nuevo contacto en una cuenta. El estado inicial depende de tu rol (misma cadena que solicitar_cuenta).\n\n" +
      "USAR CUANDO:\n" +
      "- Conoces a una nueva persona en una cuenta existente\n" +
      "- Necesitas registrar un contacto de agencia o cliente\n\n" +
      "NO USAR SI:\n" +
      "- El contacto ya existe en esa cuenta (usa consultar_cuenta para verificar)",
    parameters: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Nombre completo del contacto" },
        cuenta_nombre: {
          type: "string",
          description: "Nombre de la cuenta a la que pertenece",
        },
        rol: {
          type: "string",
          enum: ["comprador", "planeador", "decisor", "operativo"],
          description: "Rol del contacto",
        },
        seniority: {
          type: "string",
          enum: ["junior", "senior", "director"],
          description: "Nivel de seniority",
        },
        telefono: { type: "string", description: "Telefono (opcional)" },
        email: { type: "string", description: "Email (opcional)" },
        es_agencia: {
          type: "boolean",
          description:
            "Es contacto de agencia (no del cliente). Default: false",
        },
        notas: { type: "string", description: "Notas iniciales (opcional)" },
      },
      required: ["nombre"],
    },
  },
};

const TOOL_APROBAR_REGISTRO: ToolDefinition = {
  type: "function",
  function: {
    name: "aprobar_registro",
    description:
      "Aprueba una cuenta o contacto pendiente, avanzandolo al siguiente estado de la cadena.\n" +
      "- Gerente aprueba pendiente_gerente → pendiente_director (o activo_en_revision si la cuenta fue creada por director+ y requiere asignacion de ejecutivo_nombre)\n" +
      "- Director aprueba pendiente_director → activo_en_revision (o pendiente_gerente si la cuenta fue creada por VP y requiere asignacion de gerente_nombre)\n" +
      "- Director resuelve disputado → activo\n\n" +
      "IMPORTANTE: Si el sistema te pide ejecutivo_nombre o gerente_nombre, es porque la cuenta necesita asignacion del nivel inferior.\n\n" +
      "USAR CUANDO:\n" +
      "- Tienes pendientes de aprobacion (consulta con consultar_pendientes)",
    parameters: {
      type: "object",
      properties: {
        entidad_tipo: {
          type: "string",
          enum: ["cuenta", "contacto"],
          description: "Tipo de entidad a aprobar",
        },
        entidad_id: {
          type: "string",
          description: "ID de la entidad (obtenido de consultar_pendientes)",
        },
        ejecutivo_nombre: {
          type: "string",
          description:
            "Nombre del Ejecutivo a asignar (requerido cuando un gerente aprueba cuentas creadas por director+)",
        },
        gerente_nombre: {
          type: "string",
          description:
            "Nombre del Gerente a asignar (requerido cuando un director aprueba cuentas creadas por VP)",
        },
      },
      required: ["entidad_tipo", "entidad_id"],
    },
  },
};

const TOOL_RECHAZAR_REGISTRO: ToolDefinition = {
  type: "function",
  function: {
    name: "rechazar_registro",
    description:
      "Rechaza y elimina una cuenta o contacto pendiente/disputado.\n\n" +
      "USAR CUANDO:\n" +
      "- El registro es un duplicado, tiene datos incorrectos, o no debe existir\n" +
      "- Un registro disputado no cumple con los criterios de calidad",
    parameters: {
      type: "object",
      properties: {
        entidad_tipo: {
          type: "string",
          enum: ["cuenta", "contacto"],
          description: "Tipo de entidad a rechazar",
        },
        entidad_id: {
          type: "string",
          description: "ID de la entidad (obtenido de consultar_pendientes)",
        },
        motivo: {
          type: "string",
          description: "Motivo del rechazo (recomendado)",
        },
      },
      required: ["entidad_tipo", "entidad_id"],
    },
  },
};

const TOOL_CONSULTAR_PENDIENTES: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_pendientes",
    description:
      "Lista cuentas y contactos pendientes de tu aprobacion.\n" +
      "- Gerente: ve pendiente_gerente de su equipo\n" +
      "- Director: ve pendiente_director y disputados\n" +
      "- VP: ve todos los pendientes y disputados\n\n" +
      "USAR CUANDO:\n" +
      "- Quieres revisar que registros necesitan tu aprobacion\n" +
      "- En el briefing matutino para verificar pendientes",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

const TOOL_IMPUGNAR_REGISTRO: ToolDefinition = {
  type: "function",
  function: {
    name: "impugnar_registro",
    description:
      "Impugna (challenge) una cuenta o contacto en activo_en_revision dentro de las primeras 24h.\n" +
      "El registro pasa a 'disputado' y un Director debe resolver.\n\n" +
      "USAR CUANDO:\n" +
      "- Detectas un duplicado, error, o problema con un registro recien aprobado\n" +
      "- Alguien registro una cuenta que ya existe bajo otro nombre\n\n" +
      "IMPORTANTE:\n" +
      "- Solo funciona dentro de las 24h posteriores a la aprobacion del director\n" +
      "- Requiere motivo obligatorio",
    parameters: {
      type: "object",
      properties: {
        entidad_tipo: {
          type: "string",
          enum: ["cuenta", "contacto"],
          description: "Tipo de entidad a impugnar",
        },
        entidad_id: {
          type: "string",
          description: "ID de la entidad",
        },
        motivo: {
          type: "string",
          description: "Motivo de la impugnacion (requerido)",
        },
      },
      required: ["entidad_tipo", "entidad_id", "motivo"],
    },
  },
};

// ---------------------------------------------------------------------------
// Insight tools (overnight commercial intelligence)
// ---------------------------------------------------------------------------

const TOOL_CONSULTAR_INSIGHTS: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_insights",
    description:
      "Muestra los insights comerciales generados por el analisis nocturno para tus cuentas.\n\n" +
      "Cada noche, el sistema analiza todas las cuentas contra eventos, inventario, billing gaps, " +
      "peers de la vertical, y senales de mercado. Los insights se presentan con nivel de confianza " +
      "y datos de soporte.\n\n" +
      "USAR CUANDO:\n" +
      "- En tu briefing matutino para ver oportunidades detectadas\n" +
      "- Quieres revisar insights pendientes de accion\n" +
      "- Buscas oportunidades por tipo (calendario, inventario, gap, cross-sell, mercado)",
    parameters: {
      type: "object",
      properties: {
        tipo: {
          type: "string",
          enum: [
            "oportunidad_calendario",
            "oportunidad_inventario",
            "oportunidad_gap",
            "oportunidad_crosssell",
            "oportunidad_mercado",
            "riesgo",
            "patron",
            "recomendacion",
          ],
          description: "Filtrar por tipo de insight (opcional)",
        },
        estado: {
          type: "string",
          enum: [
            "nuevo",
            "briefing",
            "aceptado",
            "convertido",
            "descartado",
            "expirado",
          ],
          description:
            "Filtrar por estado (default: nuevo y briefing — los pendientes)",
        },
        limite: {
          type: "number",
          description: "Maximo de resultados (default 10)",
        },
      },
    },
  },
};

const TOOL_ACTUAR_INSIGHT: ToolDefinition = {
  type: "function",
  function: {
    name: "actuar_insight",
    description:
      "Actua sobre un insight comercial: aceptarlo o descartarlo.\n\n" +
      "- 'aceptar': Marca el insight como aceptado. El Ejecutivo tomara accion.\n" +
      "- 'descartar': Requiere razon obligatoria. La razon ayuda al sistema a mejorar.\n\n" +
      "IMPORTANTE: Cuando el Ejecutivo quiere descartar un insight, pregunta la razon " +
      "antes de llamar esta herramienta. Razones comunes: 'ya tengo propuesta en vuelo', " +
      "'relacion fria, no es buen momento', 'el cliente cambio de prioridades'.",
    parameters: {
      type: "object",
      properties: {
        insight_id: {
          type: "string",
          description: "ID del insight (obtenido de consultar_insights)",
        },
        accion: {
          type: "string",
          enum: ["aceptar", "descartar"],
          description: "Que hacer con el insight",
        },
        razon: {
          type: "string",
          description: "Razon del descarte (requerida si accion = descartar)",
        },
      },
      required: ["insight_id", "accion"],
    },
  },
};

const TOOL_CONSULTAR_INSIGHTS_EQUIPO: ToolDefinition = {
  type: "function",
  function: {
    name: "consultar_insights_equipo",
    description:
      "Resumen de insights comerciales del equipo: total generados, pendientes, " +
      "tasa de aceptacion, desglose por tipo y por Ejecutivo.\n\n" +
      "USAR CUANDO:\n" +
      "- En el briefing semanal para medir adopcion de inteligencia comercial\n" +
      "- Quieres ver que Ejecutivos estan aprovechando los insights\n" +
      "- Necesitas coaching signals: Ejecutivos que ignoran insights de alta confianza",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

// ---------------------------------------------------------------------------
// Role-based tool sets
// ---------------------------------------------------------------------------

const INSIGHT_TOOLS: ToolDefinition[] = [
  TOOL_CONSULTAR_INSIGHTS,
  TOOL_ACTUAR_INSIGHT,
];

const INSIGHT_TEAM_TOOLS: ToolDefinition[] = [
  ...INSIGHT_TOOLS,
  TOOL_CONSULTAR_INSIGHTS_EQUIPO,
];

const AE_TOOLS: ToolDefinition[] = [
  TOOL_REGISTRAR_ACTIVIDAD,
  TOOL_CREAR_PROPUESTA,
  TOOL_ACTUALIZAR_PROPUESTA,
  TOOL_CERRAR_PROPUESTA,
  TOOL_ACTUALIZAR_DESCARGA,
  TOOL_ESTABLECER_RECORDATORIO,
  TOOL_ENVIAR_EMAIL_SEGUIMIENTO,
  TOOL_CONFIRMAR_ENVIO_EMAIL,
  TOOL_CREAR_EVENTO_CALENDARIO,
  TOOL_CONSULTAR_AGENDA,
  TOOL_CONSULTAR_PIPELINE,
  TOOL_CONSULTAR_CUENTA,
  TOOL_CONSULTAR_CUENTAS,
  TOOL_CONSULTAR_INVENTARIO,
  TOOL_CONSULTAR_ACTIVIDADES,
  TOOL_CONSULTAR_DESCARGA,
  TOOL_CONSULTAR_CUOTA,
  TOOL_CONSULTAR_EVENTOS,
  TOOL_CONSULTAR_INVENTARIO_EVENTO,
  TOOL_BUSCAR_EMAILS,
  TOOL_LEER_EMAIL,
  TOOL_CREAR_BORRADOR_EMAIL,
  TOOL_LISTAR_ARCHIVOS_DRIVE,
  TOOL_LEER_ARCHIVO_DRIVE,
  TOOL_CREAR_DOCUMENTO_DRIVE,
  TOOL_BUSCAR_DOCUMENTOS,
  TOOL_BUSCAR_WEB,
  TOOL_ANALIZAR_WINLOSS,
  TOOL_ANALIZAR_TENDENCIAS,
  TOOL_RECOMENDAR_CROSSSELL,
  TOOL_GENERAR_LINK_DASHBOARD,
  TOOL_CONSULTAR_RESUMEN_DIA,
  TOOL_GENERAR_BRIEFING,
  TOOL_GUARDAR_OBSERVACION,
  TOOL_BUSCAR_MEMORIA,
  TOOL_SOLICITAR_CUENTA,
  TOOL_SOLICITAR_CONTACTO,
  TOOL_IMPUGNAR_REGISTRO,
  ...INSIGHT_TOOLS,
];

const APPROVAL_TOOLS: ToolDefinition[] = [
  TOOL_SOLICITAR_CUENTA,
  TOOL_SOLICITAR_CONTACTO,
  TOOL_APROBAR_REGISTRO,
  TOOL_RECHAZAR_REGISTRO,
  TOOL_CONSULTAR_PENDIENTES,
  TOOL_IMPUGNAR_REGISTRO,
];

const GERENTE_TOOLS: ToolDefinition[] = [
  TOOL_CONSULTAR_PIPELINE,
  TOOL_CONSULTAR_CUENTA,
  TOOL_CONSULTAR_CUENTAS,
  TOOL_CONSULTAR_INVENTARIO,
  TOOL_CONSULTAR_ACTIVIDADES,
  TOOL_CONSULTAR_DESCARGA,
  TOOL_CONSULTAR_CUOTA,
  TOOL_ENVIAR_EMAIL_BRIEFING,
  TOOL_CREAR_EVENTO_CALENDARIO,
  TOOL_CONSULTAR_AGENDA,
  TOOL_CONSULTAR_EVENTOS,
  TOOL_CONSULTAR_INVENTARIO_EVENTO,
  TOOL_BUSCAR_EMAILS,
  TOOL_LEER_EMAIL,
  TOOL_LISTAR_ARCHIVOS_DRIVE,
  TOOL_LEER_ARCHIVO_DRIVE,
  TOOL_CREAR_DOCUMENTO_DRIVE,
  TOOL_BUSCAR_DOCUMENTOS,
  TOOL_BUSCAR_WEB,
  TOOL_ANALIZAR_WINLOSS,
  TOOL_ANALIZAR_TENDENCIAS,
  TOOL_RECOMENDAR_CROSSSELL,
  TOOL_GENERAR_LINK_DASHBOARD,
  TOOL_EJECUTAR_SWARM,
  TOOL_CONSULTAR_SENTIMIENTO_EQUIPO,
  TOOL_GENERAR_BRIEFING,
  TOOL_GUARDAR_OBSERVACION,
  TOOL_BUSCAR_MEMORIA,
  TOOL_REFLEXIONAR_MEMORIA,
  ...APPROVAL_TOOLS,
  ...INSIGHT_TEAM_TOOLS,
];

const RELATIONSHIP_TOOLS: ToolDefinition[] = [
  TOOL_REGISTRAR_RELACION_EJECUTIVA,
  TOOL_REGISTRAR_INTERACCION_EJECUTIVA,
  TOOL_CONSULTAR_SALUD_RELACIONES,
  TOOL_CONSULTAR_HISTORIAL_RELACION,
  TOOL_REGISTRAR_HITO,
  TOOL_CONSULTAR_HITOS_PROXIMOS,
  TOOL_ACTUALIZAR_NOTAS_ESTRATEGICAS,
];

const DIRECTOR_TOOLS: ToolDefinition[] = [
  TOOL_CONSULTAR_PIPELINE,
  TOOL_CONSULTAR_CUENTA,
  TOOL_CONSULTAR_CUENTAS,
  TOOL_CONSULTAR_INVENTARIO,
  TOOL_CONSULTAR_ACTIVIDADES,
  TOOL_CONSULTAR_DESCARGA,
  TOOL_CONSULTAR_CUOTA,
  TOOL_CREAR_EVENTO_CALENDARIO,
  TOOL_CONSULTAR_AGENDA,
  TOOL_CONSULTAR_EVENTOS,
  TOOL_CONSULTAR_INVENTARIO_EVENTO,
  TOOL_ENVIAR_EMAIL_SEGUIMIENTO,
  TOOL_CONFIRMAR_ENVIO_EMAIL,
  TOOL_ENVIAR_EMAIL_BRIEFING,
  TOOL_BUSCAR_EMAILS,
  TOOL_LEER_EMAIL,
  TOOL_CREAR_BORRADOR_EMAIL,
  TOOL_LISTAR_ARCHIVOS_DRIVE,
  TOOL_LEER_ARCHIVO_DRIVE,
  TOOL_CREAR_DOCUMENTO_DRIVE,
  TOOL_BUSCAR_DOCUMENTOS,
  TOOL_BUSCAR_WEB,
  TOOL_ANALIZAR_WINLOSS,
  TOOL_ANALIZAR_TENDENCIAS,
  TOOL_RECOMENDAR_CROSSSELL,
  TOOL_GENERAR_LINK_DASHBOARD,
  TOOL_EJECUTAR_SWARM,
  TOOL_CONSULTAR_SENTIMIENTO_EQUIPO,
  TOOL_GENERAR_BRIEFING,
  TOOL_GUARDAR_OBSERVACION,
  TOOL_BUSCAR_MEMORIA,
  TOOL_REFLEXIONAR_MEMORIA,
  ...RELATIONSHIP_TOOLS,
  ...APPROVAL_TOOLS,
  ...INSIGHT_TEAM_TOOLS,
];

const VP_TOOLS: ToolDefinition[] = [
  TOOL_CONSULTAR_PIPELINE,
  TOOL_CONSULTAR_CUENTA,
  TOOL_CONSULTAR_CUENTAS,
  TOOL_CONSULTAR_INVENTARIO,
  TOOL_CONSULTAR_ACTIVIDADES,
  TOOL_CONSULTAR_DESCARGA,
  TOOL_CONSULTAR_CUOTA,
  TOOL_CONSULTAR_AGENDA,
  TOOL_CONSULTAR_EVENTOS,
  TOOL_CONSULTAR_INVENTARIO_EVENTO,
  TOOL_ENVIAR_EMAIL_SEGUIMIENTO,
  TOOL_CONFIRMAR_ENVIO_EMAIL,
  TOOL_ENVIAR_EMAIL_BRIEFING,
  TOOL_BUSCAR_EMAILS,
  TOOL_LEER_EMAIL,
  TOOL_CREAR_BORRADOR_EMAIL,
  TOOL_LISTAR_ARCHIVOS_DRIVE,
  TOOL_LEER_ARCHIVO_DRIVE,
  TOOL_CREAR_DOCUMENTO_DRIVE,
  TOOL_BUSCAR_DOCUMENTOS,
  TOOL_BUSCAR_WEB,
  TOOL_ANALIZAR_WINLOSS,
  TOOL_ANALIZAR_TENDENCIAS,
  TOOL_RECOMENDAR_CROSSSELL,
  TOOL_GENERAR_LINK_DASHBOARD,
  TOOL_EJECUTAR_SWARM,
  TOOL_CONSULTAR_SENTIMIENTO_EQUIPO,
  TOOL_GENERAR_BRIEFING,
  TOOL_BUSCAR_MEMORIA,
  TOOL_REFLEXIONAR_MEMORIA,
  ...RELATIONSHIP_TOOLS,
  ...APPROVAL_TOOLS,
  ...INSIGHT_TEAM_TOOLS,
];

export function getToolsForRole(
  role: "ae" | "gerente" | "director" | "vp",
): ToolDefinition[] {
  switch (role) {
    case "ae":
      return AE_TOOLS;
    case "gerente":
      return GERENTE_TOOLS;
    case "director":
      return DIRECTOR_TOOLS;
    case "vp":
      return VP_TOOLS;
  }
}

// ---------------------------------------------------------------------------
// Tool execution router
// ---------------------------------------------------------------------------

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  registrar_actividad,
  crear_propuesta,
  actualizar_propuesta,
  cerrar_propuesta,
  actualizar_descarga,
  consultar_pipeline,
  consultar_descarga,
  consultar_cuota,
  consultar_cuenta,
  consultar_cuentas,
  consultar_actividades,
  consultar_inventario,
  enviar_email_seguimiento,
  confirmar_envio_email,
  enviar_email_briefing,
  crear_evento_calendario,
  consultar_agenda,
  establecer_recordatorio,
  consultar_eventos,
  consultar_inventario_evento,
  buscar_emails,
  leer_email,
  crear_borrador_email,
  listar_archivos_drive,
  leer_archivo_drive,
  crear_documento_drive,
  buscar_documentos,
  buscar_web,
  analizar_winloss,
  analizar_tendencias,
  recomendar_crosssell,
  generar_link_dashboard,
  ejecutar_swarm,
  consultar_resumen_dia,
  consultar_sentimiento_equipo,
  generar_briefing,
  guardar_observacion,
  buscar_memoria,
  reflexionar_memoria,
  registrar_relacion_ejecutiva,
  registrar_interaccion_ejecutiva,
  consultar_salud_relaciones,
  consultar_historial_relacion,
  registrar_hito,
  consultar_hitos_proximos,
  actualizar_notas_estrategicas,
  solicitar_cuenta,
  solicitar_contacto,
  aprobar_registro,
  rechazar_registro,
  consultar_pendientes,
  impugnar_registro,
  consultar_insights,
  actuar_insight,
  consultar_insights_equipo,
};

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
  }
  return handler(args, ctx);
}

export { type ToolDefinition };
