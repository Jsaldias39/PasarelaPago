import { Inject, Injectable, Logger } from '@nestjs/common';
import { RISK_SETTINGS, type RiskSettings } from '../settings';
import type { SanctionsScreener, ScreeningEntityType, ScreeningResult } from './screener';

interface Hit {
  readonly match: number;
  readonly list?: string;
  readonly sourceId?: string;
}

/** Tipos de entidad que se prueban: el pagador puede ser una persona o una empresa y el contrato no lo distingue. */
const ENTITY_TYPES: readonly ScreeningEntityType[] = ['person', 'business'];

/**
 * Cliente de moov Watchman v2 (`GET /v2/search`). Decide por UMBRAL, nunca por «hubo resultados»: con `minMatch` bajo
 * Watchman devuelve un ranking aunque nada se parezca. Cualquier error, demora o respuesta mal formada es `unavailable`.
 */
@Injectable()
export class WatchmanScreener implements SanctionsScreener {
  private readonly logger = new Logger(WatchmanScreener.name);

  constructor(@Inject(RISK_SETTINGS) private readonly settings: RiskSettings) {}

  async screen(name: string, entityType?: ScreeningEntityType): Promise<ScreeningResult> {
    const types = entityType ? [entityType] : ENTITY_TYPES;
    const settled = await Promise.allSettled(types.map((type) => this.search(name, type)));
    const hits: Hit[] = [];
    let failed = false;
    for (const result of settled) {
      if (result.status === 'fulfilled') hits.push(...result.value);
      else failed = true;
    }
    const best = hits.reduce<Hit | undefined>((top, hit) => (top === undefined || hit.match > top.match ? hit : top), undefined);
    const detail = best ? { topScore: best.match, ...(best.list !== undefined && { list: best.list }), ...(best.sourceId !== undefined && { sourceId: best.sourceId }) } : {};
    // Una coincidencia fuerte manda aunque la otra búsqueda haya fallado: rechazar es más seguro que dudar.
    if (best && best.match >= this.settings.sanctionsDenyScore) return { outcome: 'match', ...detail };
    if (failed) return { outcome: 'unavailable', ...detail };
    if (best && best.match >= this.settings.sanctionsReviewScore) return { outcome: 'possible_match', ...detail };
    return { outcome: 'clear', ...detail };
  }

  private async search(name: string, type: string): Promise<Hit[]> {
    const url = `${this.settings.watchmanUrl}/v2/search?${new URLSearchParams({ name, type, minMatch: String(this.settings.sanctionsReviewScore), limit: '5' })}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(this.settings.screeningTimeoutMs), headers: { accept: 'application/json' } });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      return parseEntities(body);
    } catch (error) {
      // Solo la clase del error: el mensaje o la URL podrían contener el nombre que se estaba cribando.
      this.logger.warn({ err: (error as { name?: string } | null)?.name ?? 'desconocido', entity_type: type }, 'Watchman no pudo cribar');
      throw new Error('screening_failed');
    }
  }
}

function parseEntities(body: unknown): Hit[] {
  if (typeof body !== 'object' || body === null || !('entities' in body)) throw new Error('forma inesperada');
  const entities = (body as { entities: unknown }).entities;
  if (entities === null) return [];
  if (!Array.isArray(entities)) throw new Error('forma inesperada');
  return entities.map((entity) => {
    const e = entity as { match?: unknown; sourceList?: unknown; sourceID?: unknown } | null;
    if (typeof e !== 'object' || e === null || typeof e.match !== 'number' || !Number.isFinite(e.match) || e.match < 0 || e.match > 1) throw new Error('forma inesperada');
    return {
      match: e.match,
      ...(typeof e.sourceList === 'string' && { list: e.sourceList.slice(0, 40) }),
      ...(typeof e.sourceID === 'string' && { sourceId: e.sourceID.slice(0, 40) }),
    };
  });
}
