import { AdapterName, InstrumentDiscipline, type InstrumentRegistration } from '@lis/contracts';

/** Flat form fields for registering or changing an instrument (W-11). Every value is the string the browser sent. */
export type InstrumentForm = Record<string, string>;

export const FORM_FIELDS = [
  'instrumentId', 'displayName', 'manufacturer', 'model', 'serialNo', 'softwareVersion', 'discipline', 'location', 'interfaceManualRef',
  'adapter', 'adapterOptions', 'transportType', 'host', 'port', 'serialPath', 'baudRate', 'dataBits', 'parity', 'stopBits', 'flowControl',
  'bindAddress', 'allowedPeers', 'maxMessageBytes', 'noQcConfirmed',
] as const;

export function pickForm(body: Record<string, unknown> | undefined): InstrumentForm {
  const out: InstrumentForm = {};
  for (const k of FORM_FIELDS) {
    const v = body?.[k];
    out[k] = typeof v === 'string' ? v : '';
  }
  return out;
}

const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
/** A number field; left as text when it isn't one so the contract reports it. */
const num = (v: string | undefined): number | string | undefined => {
  const s = opt(v);
  if (s === undefined) return undefined;
  return /^\d+$/.test(s) ? Number(s) : s;
};
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export type FormParse = { ok: true; value: unknown } | { ok: false; issues: string[] };

/**
 * Build the registration object from the form. It is not validated here:
 * the InstrumentRegistration contract does that, with the same rules as
 * every other path in.
 */
export function formToRegistration(f: InstrumentForm): FormParse {
  let adapterOptions: unknown = {};
  const raw = opt(f['adapterOptions']);
  if (raw) {
    try {
      adapterOptions = JSON.parse(raw);
    } catch {
      return { ok: false, issues: ['adapterOptions: not valid JSON'] };
    }
  }
  // 14 §2: with no QC rule every HL7 message is a patient result, so the screen asks before saving.
  if (f['adapter'] === 'generic-hl7-mllp' && !(adapterOptions as { qcRule?: unknown } | null)?.qcRule && f['noQcConfirmed'] !== 'yes') {
    return { ok: false, issues: ['adapterOptions.qcRule: no QC rule, so every message will be treated as a patient result. Add a qcRule, or tick the box to confirm.'] };
  }
  const instrumentId = opt(f['instrumentId']) ?? '';
  const type = f['transportType'];
  const transport =
    type === 'serial'
      ? defined({ type, path: opt(f['serialPath']), baudRate: num(f['baudRate']), dataBits: num(f['dataBits']), parity: opt(f['parity']), stopBits: num(f['stopBits']), flowControl: opt(f['flowControl']) })
      : type === 'tcp-server'
        ? defined({
            type,
            bindAddress: opt(f['bindAddress']),
            port: num(f['port']),
            allowedPeers: (f['allowedPeers'] ?? '').split(/[\s,]+/).filter(Boolean),
          })
        : defined({ type: 'tcp-client', host: opt(f['host']), port: num(f['port']) });
  return {
    ok: true,
    value: defined({
      instrumentId,
      displayName: opt(f['displayName']),
      manufacturer: opt(f['manufacturer']),
      model: opt(f['model']),
      serialNo: opt(f['serialNo']),
      softwareVersion: opt(f['softwareVersion']),
      discipline: opt(f['discipline']),
      location: opt(f['location']),
      interfaceManualRef: opt(f['interfaceManualRef']),
      connection: defined({ instrumentId, adapter: opt(f['adapter']), adapterOptions, transport, maxMessageBytes: num(f['maxMessageBytes']) }),
    }),
  };
}

/** The reverse, to fill the edit form from a stored registration. */
export function registrationToForm(r: InstrumentRegistration): InstrumentForm {
  const t = r.connection.transport;
  const f: InstrumentForm = {};
  for (const k of FORM_FIELDS) f[k] = '';
  Object.assign(f, {
    instrumentId: r.instrumentId,
    displayName: r.displayName,
    manufacturer: r.manufacturer,
    model: r.model,
    serialNo: r.serialNo ?? '',
    softwareVersion: r.softwareVersion ?? '',
    discipline: r.discipline,
    location: r.location ?? '',
    interfaceManualRef: r.interfaceManualRef ?? '',
    adapter: r.connection.adapter,
    adapterOptions: Object.keys(r.connection.adapterOptions).length ? JSON.stringify(r.connection.adapterOptions, null, 2) : '',
    transportType: t.type,
    maxMessageBytes: String(r.connection.maxMessageBytes),
  });
  if (t.type === 'tcp-client') Object.assign(f, { host: t.host, port: String(t.port) });
  if (t.type === 'tcp-server') Object.assign(f, { bindAddress: t.bindAddress, port: String(t.port), allowedPeers: t.allowedPeers.join(', ') });
  if (t.type === 'serial') Object.assign(f, { serialPath: t.path, baudRate: String(t.baudRate), dataBits: String(t.dataBits), parity: t.parity, stopBits: String(t.stopBits), flowControl: t.flowControl });
  return f;
}

/** Option lists for the form's select boxes, with the current value marked. */
export function formOptions(f: InstrumentForm) {
  const mark = (values: readonly string[], current: string | undefined) => values.map((v) => ({ value: v, selected: v === current }));
  return {
    disciplines: mark(InstrumentDiscipline.options, f['discipline']),
    adapters: mark(AdapterName.options, f['adapter']),
    transports: mark(['tcp-client', 'tcp-server', 'serial'], f['transportType'] || 'tcp-client'),
    parities: mark(['none', 'even', 'odd'], f['parity'] || 'none'),
    flowControls: mark(['none', 'xonxoff', 'rtscts'], f['flowControl'] || 'none'),
  };
}

/** Shown on the form as a starting point for a generic ASTM profile. Positions must be checked against the instrument's manual. */
export const GENERIC_ASTM_EXAMPLE = JSON.stringify({ profile: 'generic-astm', sampleId: { record: 'O', field: 3, component: 1 } }, null, 2);
export const GENERIC_HL7_EXAMPLE = JSON.stringify({ profile: 'generic-hl7-mllp', sampleId: { segment: 'OBR', field: 3, component: 1 } }, null, 2);
