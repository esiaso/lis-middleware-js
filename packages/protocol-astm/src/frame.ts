import { CR, ETB, ETX, FORBIDDEN_IN_TEXT, LF, MAX_FRAME_TEXT, STX } from './constants.js';

/**
 * Checksum per ASTM E1381 as described in [e411 HIM D-3 note 4, D-4]:
 * sum every byte from the frame number up to and including ETB/ETX,
 * keep the low 8 bits, render as two uppercase hex digits.
 *
 * `body` is FN + text + terminator (ETB or ETX).
 */
export function astmChecksum(body: Uint8Array): string {
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xff;
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

/** Frame numbers run 1..7 then 0..7 (modulo 8), starting at 1 [e411 HIM D-3 note 1]. */
export function nextFrameNumber(fn: number): number {
  return (fn + 1) % 8;
}

export function encodeFrame(fn: number, text: Buffer, final: boolean): Buffer {
  if (!Number.isInteger(fn) || fn < 0 || fn > 7) throw new RangeError(`frame number ${fn}`);
  if (text.length > MAX_FRAME_TEXT) throw new RangeError(`frame text ${text.length} > ${MAX_FRAME_TEXT}`);
  for (const b of text) {
    if (FORBIDDEN_IN_TEXT.has(b)) throw new RangeError(`forbidden byte 0x${b.toString(16)} in frame text`);
  }
  const body = Buffer.concat([Buffer.from([0x30 + fn]), text, Buffer.from([final ? ETX : ETB])]);
  const cs = Buffer.from(astmChecksum(body), 'latin1');
  return Buffer.concat([Buffer.from([STX]), body, cs, Buffer.from([CR, LF])]);
}

export type FrameSplitMode =
  /** Elecsys® type: a frame carries at most one record [e411 HIM D-2]. */
  | 'record-per-frame'
  /** cobas® type: a frame may carry several records [e411 HIM D-2]. */
  | 'packed';

/**
 * Split a message (records each terminated by CR) into frame payloads.
 * A record longer than 240 bytes is split into ETB middle frames and an ETX last frame.
 */
export function splitIntoFrameTexts(
  message: Buffer,
  mode: FrameSplitMode,
): { text: Buffer; final: boolean }[] {
  const out: { text: Buffer; final: boolean }[] = [];
  if (mode === 'packed') {
    for (let i = 0; i < message.length; i += MAX_FRAME_TEXT) {
      const end = Math.min(i + MAX_FRAME_TEXT, message.length);
      out.push({ text: message.subarray(i, end), final: end === message.length });
    }
    return out;
  }
  // record-per-frame: each record ends in its own ETX frame.
  let start = 0;
  while (start < message.length) {
    let end = message.indexOf(CR, start);
    end = end === -1 ? message.length : end + 1;
    for (let i = start; i < end; i += MAX_FRAME_TEXT) {
      const stop = Math.min(i + MAX_FRAME_TEXT, end);
      out.push({ text: message.subarray(i, stop), final: stop === end });
    }
    start = end;
  }
  return out;
}

/** Encode a whole message into wire frames, numbering from 1. */
export function encodeMessageFrames(message: Buffer, mode: FrameSplitMode): Buffer[] {
  let fn = 1;
  return splitIntoFrameTexts(message, mode).map(({ text, final }) => {
    const f = encodeFrame(fn, text, final);
    fn = nextFrameNumber(fn);
    return f;
  });
}
