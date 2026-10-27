import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { FakeVaultBackend } from '../backend/fake-vault-backend';
import { VAULT_BACKEND, type VaultBackend } from '../backend/vault-backend';
import { assertBackendAllowed, SERVICE_CONFIG, type ServiceConfig } from '../config';
import { PG_POOL } from '../database.module';
import { VaultController } from './vault.controller';
import { VaultService } from './vault.service';

@Module({
  controllers: [VaultController],
  providers: [
    { provide: VAULT_BACKEND, inject: [SERVICE_CONFIG], useFactory: (config: ServiceConfig): VaultBackend => {
        // Segunda barrera: aunque alguien arme la configuración a mano, el doble no se instancia bajo `live`.
        assertBackendAllowed(config.payMode, config.backend);
        return config.backend === 'fake' ? new FakeVaultBackend() : (undefined as never);
      },
    },
    { provide: VaultService, inject: [PG_POOL, VAULT_BACKEND], useFactory: (pool: Pool, backend: VaultBackend) => new VaultService(pool, backend) },
  ],
})
export class VaultModule {}
