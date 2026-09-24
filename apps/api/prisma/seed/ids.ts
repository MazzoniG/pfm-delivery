import { createHash } from 'node:crypto';

const NAMESPACE = 'pfm.seed.v1';

/**
 * A UUIDv5 over a stable name, so every seeded row keeps its id across runs and
 * across machines. The column default is `uuidv7()`, which is time-ordered and
 * therefore exactly what a byte-identical reseed cannot use.
 */
export const seedId = (name: string): string => {
  const hash = createHash('sha1').update(`${NAMESPACE}:${name}`).digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);

  const hex = hash.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
};
