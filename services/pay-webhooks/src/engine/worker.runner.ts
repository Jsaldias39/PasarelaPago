import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { DeliveryWorker } from './delivery.worker';

/** Ejecuta el `DeliveryWorker` en un bucle. Sin solapamiento (una ejecución a la vez) y cierra limpio al apagar. */
@Injectable()
export class WorkerRunner implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerRunner.name);
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();

  constructor(
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    private readonly worker: DeliveryWorker,
  ) {}

  onModuleInit(): void {
    if (this.config.workerEnabled) this.schedule();
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
    }, this.config.delivery.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    try {
      let summary;
      do summary = await this.worker.runOnce();
      while (summary.claimed >= this.config.delivery.batchSize && !this.stopped);
    } catch (error) {
      // Solo nombre y SQLSTATE: el mensaje de un error de base puede traer valores (regla 90.2.1).
      this.logger.error({ err: error instanceof Error ? error.name : 'desconocido', code: (error as { code?: string }).code }, 'El trabajador de entregas falló');
    }
  }
}
