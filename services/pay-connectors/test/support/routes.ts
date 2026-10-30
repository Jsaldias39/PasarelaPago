import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

const NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
};

/** Rutas que declaran los controladores (`METHOD /ruta/{param}`), para compararlas con las operaciones del contrato. */
export function routesOf(...controllers: Array<new (...args: never[]) => unknown>): string[] {
  const out: string[] = [];
  for (const controller of controllers) {
    const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '').replace(/^\/|\/$/g, '');
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (method === undefined) continue;
      const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '').replace(/^\/|\/$/g, '');
      out.push(`${NAMES[method]} /${[prefix, path].filter(Boolean).join('/').replace(/:([A-Za-z]+)/g, '{$1}')}`);
    }
  }
  return out.sort();
}
