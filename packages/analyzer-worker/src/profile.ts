import { E411Options } from '@lis/adapter-cobas-e411';
import { buildAck, MindrayOptions, readHeader } from '@lis/adapter-mindray-hl7';
import { buildGenericAck, readGenericHeader } from '@lis/adapter-generic';
import { GenericHl7Profile, type InstrumentConnectionConfig } from '@lis/contracts';
import { E411_DEFAULT_TIMINGS, type AstmLinkTimings, type FrameSplitMode } from '@lis/protocol-astm';
import { parseHl7 } from '@lis/protocol-hl7v2';

export type LinkProfile =
  | { protocol: 'astm'; timings: AstmLinkTimings; splitMode: FrameSplitMode }
  | { protocol: 'mllp'; buildReply: (payload: Buffer, controlId: string, now: Date) => Buffer | undefined };

/**
 * Link-level behaviour for each driver. Message content (parsing, mapping,
 * matching) happens later in the jobs worker, from the stored raw message.
 */
export function linkProfile(conn: InstrumentConnectionConfig): LinkProfile {
  switch (conn.adapter) {
    case 'cobas-e411-astm': {
      const o = E411Options.parse(conn.adapterOptions);
      // cobas® type packs records into frames; Elecsys® type sends one record per frame [e411 HIM D-2].
      return { protocol: 'astm', timings: E411_DEFAULT_TIMINGS, splitMode: o.protocolType === 'cobas' ? 'packed' : 'record-per-frame' };
    }
    case 'cobas-c111-astm':
      // Record-per-frame outbound framing for the c 111 (04 §4, T-31). Same E1381 timings.
      return { protocol: 'astm', timings: E411_DEFAULT_TIMINGS, splitMode: 'record-per-frame' };
    case 'generic-astm':
      // Generic profiles never send anything but ACK/NAK, so split mode is unused.
      return { protocol: 'astm', timings: E411_DEFAULT_TIMINGS, splitMode: 'record-per-frame' };
    case 'mindray-hl7-mllp': {
      const o = MindrayOptions.parse(conn.adapterOptions);
      return {
        protocol: 'mllp',
        buildReply: (payload, controlId, now) => {
          // Without a readable MSH we cannot address an ACK; the stored message is quarantined downstream
          // and the analyzer resends per its own rules.
          const header = tryHeader(() => readHeader(parseHl7(new TextDecoder('utf-8', { fatal: true }).decode(payload))));
          return header ? buildAck(header, controlId, o, now) : undefined;
        },
      };
    }
    case 'generic-hl7-mllp': {
      const p = GenericHl7Profile.parse(conn.adapterOptions);
      return {
        protocol: 'mllp',
        buildReply: (payload, controlId, now) => {
          const text = p.encoding === 'utf-8' ? tryHeader(() => new TextDecoder('utf-8', { fatal: true }).decode(payload)) : payload.toString('latin1');
          const header = text === undefined ? undefined : tryHeader(() => readGenericHeader(parseHl7(text)));
          return header ? buildGenericAck(header, p, controlId, now, 'UTC') : undefined;
        },
      };
    }
  }
}

function tryHeader<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
