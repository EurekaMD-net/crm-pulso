/**
 * Engine logger.ts shim for CRM container.
 * Provides pino-compatible API surface using stderr JSON output.
 */

function log(level: string, obj: Record<string, unknown>, msg?: string) {
  const entry = { level, time: Date.now(), ...obj, ...(msg ? { msg } : {}) };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

function makeLogger(base: Record<string, unknown> = {}) {
  return {
    info: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
      if (typeof objOrMsg === 'string') log('info', base, objOrMsg);
      else log('info', { ...base, ...objOrMsg }, msg);
    },
    warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
      if (typeof objOrMsg === 'string') log('warn', base, objOrMsg);
      else log('warn', { ...base, ...objOrMsg }, msg);
    },
    error: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
      if (typeof objOrMsg === 'string') log('error', base, objOrMsg);
      else log('error', { ...base, ...objOrMsg }, msg);
    },
    debug: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
      if (typeof objOrMsg === 'string') log('debug', base, objOrMsg);
      else log('debug', { ...base, ...objOrMsg }, msg);
    },
    child: (bindings: Record<string, unknown>) => makeLogger({ ...base, ...bindings }),
  };
}

export const logger = makeLogger({ module: 'engine' });
