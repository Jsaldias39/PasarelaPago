/**
 * Destino de los logs del servicio. Por defecto es la salida estándar; las pruebas lo reemplazan para capturar lo que
 * se escribe y comprobar que no hay datos personales (regla 90.2). No cambia el formato de pino.
 */
export interface LogTarget {
  write(chunk: string): unknown;
}

export const logSink = {
  target: process.stdout as LogTarget,
  write(chunk: string): unknown {
    return this.target.write(chunk);
  },
};
