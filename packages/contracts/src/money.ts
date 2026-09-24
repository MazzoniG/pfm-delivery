import { z } from 'zod';

/**
 * Money crosses the wire as a base-10 string of signed minor units, because
 * JSON numbers are IEEE-754 doubles and BIGINT amounts are not safely
 * representable in one. Parse to `bigint`, never to `number`.
 *
 * A schema carrying money therefore parses to `bigint` while its wire form is a
 * string, which is why those schemas also export a `…Wire` type: the parsed one
 * is what a consumer gets, the wire one is what a mapper builds.
 */
export const MinorUnits = z
  .string()
  .regex(/^-?\d+$/, 'must be an integer string of minor units')
  .transform((s) => BigInt(s));

export const minorUnitsToString = (v: bigint): string => v.toString();

export type MinorUnits = bigint;
