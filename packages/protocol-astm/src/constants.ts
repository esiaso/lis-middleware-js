/** ASTM E1381 control characters [e411 HIM D-3, H-2]. */
export const STX = 0x02;
export const ETX = 0x03;
export const EOT = 0x04;
export const ENQ = 0x05;
export const ACK = 0x06;
export const LF = 0x0a;
export const CR = 0x0d;
export const NAK = 0x15;
export const ETB = 0x17;

/** Max text bytes per frame [e411 HIM D-3]. */
export const MAX_FRAME_TEXT = 240;
/** Max whole frame: STX FN text(240) ETB/ETX C1 C2 CR LF = 247 [e411 HIM B-2, D-3]. */
export const MAX_FRAME_BYTES = 247;

/**
 * Bytes that must not appear inside frame text [e411 HIM D-3 note 2]:
 * SOH STX ETX EOT ENQ ACK LF DLE DC1-DC4 NAK SYN ETB.
 */
export const FORBIDDEN_IN_TEXT: ReadonlySet<number> = new Set([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0a, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
]);

export type ControlChar = 'ENQ' | 'ACK' | 'NAK' | 'EOT';

export const CONTROL_BY_BYTE: ReadonlyMap<number, ControlChar> = new Map([
  [ENQ, 'ENQ'],
  [ACK, 'ACK'],
  [NAK, 'NAK'],
  [EOT, 'EOT'],
]);
