/**
 * Ports the analyzer worker needs from the outside world. The database
 * implementation lives in the worker app; tests use in-memory fakes.
 * Every `store*` call must resolve only after the data is durably committed:
 * the session acknowledges the instrument only after that.
 */

export interface LinkEvent {
  level: 'info' | 'warn';
  code: string;
  detail?: string;
}

export interface AstmFrameRecord {
  fn: number;
  raw: Buffer;
  final: boolean;
  receivedAt: Date;
}

export interface AstmTransferRecord {
  /** Concatenated frame text (records with CRs). */
  text: Buffer;
  complete: boolean;
  frameCount: number;
  /** Set when the transfer ended without EOT (timeout, ENQ during transfer). */
  abortedReason?: string;
  receivedAt: Date;
}

export interface RawMessageStore {
  /** One ASTM frame, before its ACK. */
  storeAstmFrame(f: AstmFrameRecord): Promise<void>;
  /** The assembled transfer; returns the raw message ID used downstream. */
  storeAstmTransfer(t: AstmTransferRecord): Promise<string>;
  /** One MLLP payload, before its ACK. Returns the raw message ID. */
  storeMllpMessage(m: { payload: Buffer; receivedAt: Date }): Promise<string>;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
