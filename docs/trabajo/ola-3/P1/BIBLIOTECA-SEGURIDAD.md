# Núcleo de seguridad compartido (`@pay/idempotency`) y cómo lo adoptan los demás servicios (P1, ola 3)

> Peldaño: **`TESTED`** (pruebas dirigidas en verde, salida en `evidencia/3a-gates.txt`); `pay-edge`, `pay-webhooks` y la plantilla lo usan. Los demás servicios **todavía tienen copias propias** (lista abajo).
> Sin commit.

## Dónde vive y por qué ahí

Código en **`contracts/packages/idempotency/src/`**, exportado desde `@pay/idempotency`. Se eligió esta librería (y no `orm-queryable` ni un paquete nuevo) porque **los 11 servicios que importan
librerías ya dependen de ella** (todos menos `pay-mockbank`) y así no se agrega ningún workspace ni ninguna dependencia: `yarn.lock` no se mueve. El nombre no es el ideal (hoy es el «núcleo de seguridad
compartido»); moverlo a un paquete propio después es un cambio mecánico (mover los archivos y cambiar el import).

| Archivo | Exporta | Reemplaza a |
|---|---|---|
| `card-number.ts` | `containsCardNumber(texto)`, `safeIdempotencyKey(clave)` | `pan-guard.ts` de pay-edge (copia), `pay-payments/src/domain/pan.ts`, `pay-vault/src/redact.ts` (`containsPan`), `pay-mockbank/src/sandbox/dto.ts`, `pay-webhooks/src/events/payload-policy.ts` |
| `url-mask.ts` | `safeUrl`, `maskUrl`, `maskSpanAttributes`, `URL_PATH_ATTRIBUTES`, `URL_QUERY_ATTRIBUTES` | `log-safe.ts` (`safeUrl`) y `masking-exporter.ts` / `scrub.ts` de cada servicio |
| `pool-guard.ts` | `guardPool(pool, log?)` | `pay-connectors/src/pool-guard.ts` y las copias de los demás |

## 1 · `containsCardNumber` — qué detecta (y su costo)

Normaliza (NFKC; fuera los caracteres de formato `\p{Cf}`: ancho cero, guion suave, marcas de dirección; todo dígito decimal de cualquier escritura `\p{Nd}` pasa a ASCII), convierte **todo carácter que no sea
letra ni dígito** (`+ : ; | , * # ~ - _ . /`, espacios, controles, emojis…) en un separador, toma cada corrida de grupos de dígitos unidos por separadores y prueba con Luhn **toda** ventana contigua de 13 a 19 dígitos
(O(n), sin retroceso de regex; 100 KB de dígitos en milisegundos). Un PAN pegado a otros dígitos, partido por separadores raros o escrito en otra escritura no se esconde.

**Costo declarado:** casi todo número de 20 dígitos o más, y una clave hexadecimal con 13 o más dígitos decimales seguidos (≈ 1 de cada 500 claves de 32 hex), se marcan aunque no sean tarjetas. **Por eso no se usa para rechazar claves de
idempotencia** (abajo). Límite: no detecta un PAN partido por **letras** ni codificado (base64, hex).

Pruebas: `card-number.spec.ts` (≈ 60 casos en tres niveles: correcto; límite = 13/15/19 exactos, 28 separadores distintos, mezclados y en corridas de 500, dígitos antes y después, otras escrituras, caracteres invisibles;
inválido = 100 KB de dígitos / separadores / otra escritura en < 2 s y entradas que no lanzan).

### `safeIdempotencyKey` (la `Idempotency-Key` se guarda en claro)
`IdempotencyStore.execute` guarda la clave tal cual en `idempotency_keys.key` (24 h). Una clave con forma de PAN se guarda como `masked-<sha256>`: la misma clave da el mismo valor (la idempotencia sigue funcionando), el PAN no queda en la
base. **No se rechaza** (un falso positivo tiraría una petición legítima, y las claves internas como `pi_…:risk` también pasan por acá). `pay-edge` además la reenvía ya enmascarada, así el PAN no viaja en cabeceras entre servicios.
Adopción: **ninguna acción** si el servicio usa `IdempotencyStore` de `@pay/idempotency` (lo hace por dentro). Si un servicio guarda o reenvía la clave por su cuenta, que pase por `safeIdempotencyKey(clave)`.

## 2 · `safeUrl` / `maskSpanAttributes` — rutas y spans

`safeUrl(url)`: conserva solo palabras de ruta (`[a-z_]`, sin dígitos; `v1`/`v2`) e ids propios (prefijo de contrato + cuerpo alfanumérico de 8 a 64 con al menos una letra, sin PAN y sin 6 dígitos seguidos); lo demás ⇒ `:x`; nunca la query ni el
fragmento. `maskSpanAttributes(atributos)` (en el sitio): enmascara la ruta de `url.path`, `url.full`, `url.original`, `http.target`, `http.url`, `http.route`, `http.path`, `http.request.target`; reemplaza por `[redacted]` la query de `url.query`, `http.query`,
`http.request.query`; y redacta cualquier **otro** `url.*`/`http.*` de texto que lleve un PAN. Prueba que recorre **cada** atributo de las dos listas con PAN, NIT y CI en ruta y query: `url-mask.spec.ts`.

Adopción (cambio mecánico, por servicio):
1. `src/log-safe.ts` ⇒ `export { safeUrl } from '@pay/idempotency';` (mantiene los imports del servicio).
2. `src/observability/telemetry.ts` (o `masking-exporter.ts` / `scrub.ts`) ⇒ en `export(spans, cb)`: `for (const span of spans) maskSpanAttributes(span.attributes as Record<string, unknown>);` y borrar la lista local de atributos y `maskUrl`.
3. Pruebas del servicio: las de tres niveles de `safeUrl` siguen valiendo (si alguna esperaba conservar un id con 6+ dígitos seguidos, ver el límite); agregar una que ejercite el exportador del servicio (modelo: `services/pay-edge/test/telemetry.spec.ts`).
Diferencias a tener en cuenta: pay-payments/pay-vault/pay-connectors ya enmascaraban `url.query`/`http.query`; la lista compartida suma `url.original`, `http.path`, `http.request.target`, `http.request.query` y la redacción genérica de `url.*`/`http.*`.

## 3 · `guardPool` — un `pg.Pool` que no mata el proceso

Cubre dos caminos que tumban Node (un `error` sin escucha es una excepción no capturada): la conexión **ociosa** que Postgres corta (`pool.on('error')`) y la **prestada** cortada a mitad de una transacción (`pool.on('connect', c => c.on('error', …))`;
lo demostró P4). Nunca registra `error.message`: `log` recibe solo `{ err: <nombre> }`. Sin NestJS: cada servicio pasa su logger.

```ts
import { guardPool } from '@pay/idempotency';
return guardPool(new Pool({ /* … */ }), (event) => new Logger('PgPool').warn(event, 'Conexión de Postgres cortada; el pool la repone'));
```

Adopción: reemplazar `src/pool-guard.ts` local (y sus llamadas) por este import; mantener la prueba del servicio o copiar `test/pool-error.spec.ts` de pay-edge (corta con `pg_terminate_backend`, contra Postgres real, una conexión ociosa, varias a
la vez, y una prestada en medio de una transacción; verifica que no hay `uncaughtException` y que el log no trae el mensaje). Pruebas de la librería: `pool-guard.spec.ts`, **con control negativo en un proceso real aparte** (sin `guardPool` el proceso muere; con
`guardPool` termina bien). Control negativo en pay-edge: `evidencia/pool-error-control-negativo.txt` (quitar `guardPool` hace fallar `pool-error.spec.ts`).
**Pendiente conocido:** el pool interno de MikroORM (plantilla) no pasa por `guardPool`; la prueba de la plantilla corta también esas sesiones y no mata el proceso, pero no se instrumentó el pool del ORM por separado.

## Quién ya lo usa y quién falta

| Servicio | `containsCardNumber` | `safeUrl`/`maskSpanAttributes` | `guardPool` | `safeIdempotencyKey` |
|---|---|---|---|---|
| pay-edge | **sí** (pan-guard y clave) | **sí** | **sí** | **sí** (reenvía enmascarada) |
| pay-webhooks | copia propia en `payload-policy.ts` | **sí** | **sí** | **sí** (por la librería) |
| plantilla (`platform/templates/service`) | — | **sí** | **sí** | por la librería |
| pay-payments, pay-vault | copia propia (`containsPan`) | copia propia (`safeUrl` más estricto: ver diferencias) | copia | por la librería |
| pay-merchants, pay-risk, pay-schedules, pay-ledger, pay-settlement | — | copia propia | copia | por la librería |
| pay-connectors, pay-qr, pay-mockbank | — | `scrub.ts` propio | `pool-guard.ts` propio (pay-connectors) | por la librería (mockbank no) |

`pan-guard` de pay-edge y `payload-policy` de pay-webhooks usan reglas de recorrido propias (tokens JSON, política de payload) y solo el núcleo `containsCardNumber` es común; `payload-policy.ts` **no se tocó** (queda como adopción pendiente).
