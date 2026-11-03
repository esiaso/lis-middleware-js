import { z } from 'zod';

/**
 * Clinical numbers are carried as decimal STRINGS, never JavaScript numbers,
 * so no floating-point rounding can touch a clinical value.
 */
export const DecimalString = z.string().regex(/^[+-]?\d+(\.\d+)?$/, 'decimal string');
export type DecimalString = z.infer<typeof DecimalString>;

export const Comparator = z.enum(['<', '<=', '>', '>=']);
export type Comparator = z.infer<typeof Comparator>;

export const ResultValue = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('numeric'),
    value: DecimalString,
    /** Digits after the decimal point, as reported. */
    scale: z.number().int().min(0).max(20),
  }),
  z.object({
    /** Values such as "<0.01" or ">1000". */
    kind: z.literal('censored'),
    comparator: Comparator,
    limit: DecimalString,
  }),
  z.object({
    kind: z.literal('qualitative'),
    code: z.string().min(1).max(40),
  }),
  z.object({
    kind: z.literal('text'),
    text: z.string().max(4000),
  }),
  z.object({
    kind: z.literal('absent'),
    reason: z.enum(['no-result', 'masked', 'not-performed']),
  }),
]);
export type ResultValue = z.infer<typeof ResultValue>;
