import { E411Options, parseE411Transfer } from '@lis/adapter-cobas-e411';
import { parseMindrayPayload } from '@lis/adapter-mindray-hl7';
import { parseGenericAstmTransfer, parseGenericHl7Payload } from '@lis/adapter-generic';
import { GenericAstmProfile, GenericHl7Profile, type InstrumentConnectionConfig, type NormalizedAnalyzerMessage } from '@lis/contracts';

/** A message that will never decode, whatever we retry: it goes to the failed list for a person to look at. */
export class PermanentDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDecodeError';
  }
}

export interface DecodeContext {
  rawMessageId: string;
  instrumentId: string;
  receivedAt: string;
}

export interface Decoded {
  messages: NormalizedAnalyzerMessage[];
  /** Why nothing (or not everything) became a result, e.g. "order query", "unsupported message type". */
  notes: string[];
}

/** Run the instrument's adapter over one stored raw message. Pure apart from the adapters' own parsing. */
export function decodeRaw(conn: InstrumentConnectionConfig, bytes: Buffer, ctx: DecodeContext): Decoded {
  try {
    switch (conn.adapter) {
      case 'cobas-e411-astm': {
        const r = parseE411Transfer(bytes, E411Options.parse(conn.adapterOptions), ctx);
        const notes = [...r.errors, ...(r.queries.length ? [`${r.queries.length} order quer${r.queries.length === 1 ? 'y' : 'ies'} (answered on the link)`] : [])];
        return { messages: r.results, notes };
      }
      case 'cobas-c111-astm':
        throw new PermanentDecodeError('the cobas c 111 result parser is not built yet (phase 3b); the raw message is kept and can be replayed');
      case 'mindray-hl7-mllp': {
        const r = parseMindrayPayload(bytes, ctx);
        if (r.kind === 'result') return { messages: [r.message], notes: [] };
        return { messages: [], notes: [r.kind === 'worklist-query' ? 'worklist query (answered on the link)' : `unsupported message type ${r.header.messageType}`] };
      }
      case 'generic-astm': {
        const r = parseGenericAstmTransfer(bytes, GenericAstmProfile.parse(conn.adapterOptions), ctx);
        const notes = [...r.errors, ...(r.unsupportedQueries ? [`${r.unsupportedQueries} host quer${r.unsupportedQueries === 1 ? 'y' : 'ies'} ignored (generic profile)`] : [])];
        return { messages: r.results, notes };
      }
      case 'generic-hl7-mllp': {
        const r = parseGenericHl7Payload(bytes, GenericHl7Profile.parse(conn.adapterOptions), ctx);
        if (r.kind === 'result') return { messages: r.messages, notes: [] };
        return { messages: [], notes: [`message type ${r.header.messageType} stored, not a result`] };
      }
    }
  } catch (e) {
    if (e instanceof PermanentDecodeError) throw e;
    // Parser rejections (invalid UTF-8, no MSH, malformed header) do not change on retry.
    throw new PermanentDecodeError(`decode failed: ${(e as Error).message}`);
  }
}
