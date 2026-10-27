import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import type { ConnectorCode, Method } from '../domain/connector';
import type { ConnectorRegistry } from '../domain/registry';
import { DEFAULT_RULE_SET, parseRuleSet, selectCandidates, type RoutingChoice, type RuleSet } from '../domain/routing';
import { HealthService } from './health.service';
import { REGISTRY } from './tokens';

/** Ruteo declarativo: reglas versionadas en la base (una activa), disponibilidad = registrado + sano + soporta el medio. */
@Injectable()
export class RoutingService implements OnModuleInit {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REGISTRY) private readonly registry: ConnectorRegistry,
    private readonly health: HealthService,
  ) {}

  /** Siembra la versión 1 si no hay ninguna activa. Idempotente: la segunda corrida no inserta nada. */
  async onModuleInit(): Promise<void> {
    const active = await this.pool.query('SELECT 1 FROM routing_rule_sets WHERE active');
    if (active.rows.length > 0) return;
    await this.pool.query('INSERT INTO routing_rule_sets (version, rules, active) VALUES ($1, $2::jsonb, true) ON CONFLICT (version) DO NOTHING', [DEFAULT_RULE_SET.version, JSON.stringify(DEFAULT_RULE_SET.rules)]);
  }

  async activeRuleSet(): Promise<RuleSet> {
    const row = await this.pool.query('SELECT version, rules FROM routing_rule_sets WHERE active');
    if (row.rows.length === 0) return DEFAULT_RULE_SET;
    return parseRuleSet({ version: row.rows[0].version, rules: row.rows[0].rules });
  }

  async choose(request: { method: Method; amountMinor: bigint; preferred?: ConnectorCode }): Promise<RoutingChoice> {
    const [ruleSet, down] = await Promise.all([this.activeRuleSet(), this.health.downSet()]);
    return selectCandidates(ruleSet, request, (code) => {
      const connector = this.registry.get(code);
      return { registered: connector !== undefined, down: down.has(code), methods: connector?.methods ?? [] };
    });
  }
}
