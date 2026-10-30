import { Inject, Injectable, Logger, Optional, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { SERVICE_CONFIG, type ServiceConfig } from '../../config';
import { SvixReconciler } from './svix-reconciler';

export const SVIX_RECONCILER = Symbol('SVIX_RECONCILER');

/** Ejecuta el `SvixReconciler` en un bucle. Sin solapamiento, y cierra limpio al apagar. No hace nada con el motor en proceso. */
@Injectable()
export class SvixReconcileRunner implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SvixReconcileRunner.name);
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();

  constructor(
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    @Optional() @Inject(SVIX_RECONCILER) private readonly reconciler: SvixReconciler | undefined,
  ) {}

  onModuleInit(): void {
    if (this.reconciler && this.config.workerEnabled) this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => this.schedule());
    }, this.config.svix?.reconcileIntervalMs ?? 15_000);
  }

  private async tick(): Promise<void> {
    try {
      await this.reconciler?.runOnce();
    } catch (error) {
      // Solo nombre y SQLSTATE: el mensaje de un error de base puede traer valores (regla 90.2.1).
      this.logger.error({ err: error instanceof Error ? error.name : 'desconocido', code: (error as { code?: string }).code }, 'La reconciliación con Svix falló');
    }
  }
}
