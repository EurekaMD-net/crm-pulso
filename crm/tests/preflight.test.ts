import { describe, it, expect } from "vitest";
import { checkPreflight } from "../src/preflight.js";

describe("preflight validation", () => {
  describe("email tools", () => {
    it("rejects invalid email address", () => {
      const err = checkPreflight("enviar_email_seguimiento", {
        destinatario: "not-an-email",
      });
      expect(err).not.toBeNull();
      expect(err).toContain("email inválida");
    });

    it("accepts valid email", () => {
      expect(
        checkPreflight("enviar_email_seguimiento", {
          destinatario: "user@example.com",
        }),
      ).toBeNull();
    });

    it("rejects very short email body", () => {
      const err = checkPreflight("crear_borrador_email", {
        destinatario: "user@example.com",
        cuerpo: "Hi",
      });
      expect(err).not.toBeNull();
      expect(err).toContain("corto");
    });

    it("accepts normal email body", () => {
      expect(
        checkPreflight("crear_borrador_email", {
          destinatario: "user@example.com",
          cuerpo: "Buenos días, le envío la propuesta actualizada.",
        }),
      ).toBeNull();
    });

    it("checks enviar_email_briefing too", () => {
      const err = checkPreflight("enviar_email_briefing", {
        to: "bad-email",
      });
      expect(err).not.toBeNull();
    });
  });

  describe("proposal tools", () => {
    it("rejects zero or negative valor_estimado", () => {
      expect(
        checkPreflight("crear_propuesta", { valor_estimado: 0 }),
      ).not.toBeNull();
      expect(
        checkPreflight("crear_propuesta", { valor_estimado: -100 }),
      ).not.toBeNull();
    });

    it("accepts positive valor_estimado", () => {
      expect(
        checkPreflight("crear_propuesta", { valor_estimado: 50000 }),
      ).toBeNull();
    });

    it("rejects empty propuesta_id on update", () => {
      expect(
        checkPreflight("actualizar_propuesta", { propuesta_id: "" }),
      ).not.toBeNull();
    });

    it("rejects empty propuesta_id on close", () => {
      expect(
        checkPreflight("cerrar_propuesta", { propuesta_id: "  " }),
      ).not.toBeNull();
    });

    it("accepts valid propuesta_id", () => {
      expect(
        checkPreflight("actualizar_propuesta", { propuesta_id: "abc-123" }),
      ).toBeNull();
    });
  });

  describe("activity logging", () => {
    it("rejects very short description", () => {
      expect(
        checkPreflight("registrar_actividad", { descripcion: "hi" }),
      ).not.toBeNull();
    });

    it("accepts normal description", () => {
      expect(
        checkPreflight("registrar_actividad", {
          descripcion: "Llamada con cliente sobre renovación",
        }),
      ).toBeNull();
    });
  });

  describe("package builder", () => {
    it("rejects missing cuenta_id", () => {
      expect(checkPreflight("construir_paquete", {})).not.toBeNull();
    });

    it("accepts valid cuenta_id", () => {
      expect(
        checkPreflight("construir_paquete", { cuenta_id: "cuenta-1" }),
      ).toBeNull();
    });
  });

  describe("unknown tools", () => {
    it("passes through without checks", () => {
      expect(
        checkPreflight("consultar_pipeline", { anything: true }),
      ).toBeNull();
    });
  });
});
