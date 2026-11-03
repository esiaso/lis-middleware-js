import type { NormalizedAnalyzerMessage, Observation } from '@lis/contracts';

export const ADAPTER_VERSION = '0.1.0';

export interface GenericParseContext {
  rawMessageId: string;
  instrumentId: string;
  receivedAt: string;
}

export function mapStatus(code: string, map: Record<string, 'initial' | 'rerun' | 'final'>): Observation['resultStatus'] {
  return map[code.trim().toUpperCase()] ?? map[code.trim()] ?? 'unknown';
}

export function emptyMessage(
  adapterName: string,
  ctx: GenericParseContext,
  profileVersion: number,
): NormalizedAnalyzerMessage {
  return {
    schemaVersion: 1,
    rawMessageId: ctx.rawMessageId as NormalizedAnalyzerMessage['rawMessageId'],
    instrumentId: ctx.instrumentId as NormalizedAnalyzerMessage['instrumentId'],
    adapter: { name: adapterName, version: ADAPTER_VERSION },
    receivedAt: ctx.receivedAt,
    kind: 'result',
    sampleClass: 'patient',
    sampleIdReadError: false,
    // Every message says it came through a generic profile, so reviewers and audits can see it.
    instrumentContext: { driver: 'generic', profileVersion: String(profileVersion) },
    observations: [],
    warnings: [],
  };
}
