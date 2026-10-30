import { isIP } from 'node:net';

/**
 * ¿Es una dirección IP pública, enrutable en Internet? Es una LISTA DE PERMITIDOS por exclusión de rangos reservados:
 * todo lo que no se pueda demostrar público (o no se pueda interpretar) se trata como no público.
 *
 * IPv4 bloqueado: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local y metadatos de nube), 172.16/12, 192.0.0/24,
 * 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 (multicast) y 240/4 (reservado).
 * IPv6: solo 2000::/3 (unicast global) y, dentro de él, se quitan 2001::/23 (incluye Teredo), 2001:db8::/32, 2002::/16 (6to4);
 * las formas con IPv4 embebido (::ffff:a.b.c.d, 64:ff9b::/96) se evalúan por la IPv4 que llevan.
 */

type Range4 = readonly [base: string, bits: number];

const BLOCKED_V4: readonly Range4[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inRange4(value: number, [base, bits]: Range4): boolean {
  const start = v4ToInt(base)!;
  const size = 2 ** (32 - bits);
  return value >= start && value < start + size;
}

export function isPublicIpv4(ip: string): boolean {
  const value = v4ToInt(ip);
  if (value === null) return false;
  return !BLOCKED_V4.some((range) => inRange4(value, range));
}

/** Expande una IPv6 a ocho grupos de 16 bits. Devuelve `null` si no se puede interpretar sin ambigüedad. */
function expandV6(ip: string): number[] | null {
  if (ip.includes('%')) return null; // zona (fe80::1%eth0): no es una dirección pública
  let text = ip;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const v4 = v4ToInt(dotted[1]);
    if (v4 === null) return null;
    text = `${text.slice(0, -dotted[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 && fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

export function isPublicIpv6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return false;
  const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // ::ffff:0:0/96 (mapeada) y 64:ff9b::/96 (NAT64): vale la IPv4 que llevan.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicIpv4(embeddedV4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicIpv4(embeddedV4(g[6], g[7]));
  // Solo unicast global 2000::/3.
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x200) return false; // 2001::/23 (IETF, Teredo, benchmarking, ORCHID…)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentación
  if (g[0] === 0x2002) return false; // 6to4
  return true;
}

/** `true` solo si `ip` es una dirección IPv4 o IPv6 pública. Cualquier otra cosa, o cualquier duda, es `false`. */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicIpv4(ip);
  if (family === 6) return isPublicIpv6(ip);
  return false;
}
