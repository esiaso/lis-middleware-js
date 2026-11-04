import type { TestMapping } from '@lis/contracts';
import type { Form } from './controllers.js';

/** One editable row, exactly as typed (W-9). */
export interface MappingRow {
  n: number;
  localTestCode: string;
  instrumentTestCode: string;
  instrumentCodeSystem: string;
  direction: string;
  expectedUnits: string;
  decimals: string;
  qualitative: string;
  reportable: boolean;
  ruo: boolean;
  remove: boolean;
}

export const BLANK_ROWS = 5;
export const MAX_ROWS = 300;

const empty = (n: number): MappingRow => ({ n, localTestCode: '', instrumentTestCode: '', instrumentCodeSystem: '', direction: 'both', expectedUnits: '', decimals: '', qualitative: '', reportable: true, ruo: false, remove: false });

/** "-1=NEG, 1=POS" ↔ {"-1":"NEG","1":"POS"} */
export function qualitativeText(map: Record<string, string> | undefined): string {
  return map ? Object.entries(map).map(([k, v]) => `${k}=${v}`).join(', ') : '';
}

export function rowsFromMappings(list: TestMapping[], blanks = BLANK_ROWS): MappingRow[] {
  const rows: MappingRow[] = list.map((m, i) => ({
    ...empty(i),
    localTestCode: m.localTestCode,
    instrumentTestCode: m.instrumentTestCode,
    instrumentCodeSystem: m.instrumentCodeSystem ?? '',
    direction: m.direction,
    expectedUnits: m.expectedUnits ?? '',
    decimals: m.decimals === undefined ? '' : String(m.decimals),
    qualitative: qualitativeText(m.qualitativeMap),
    reportable: m.reportable,
    ruo: m.ruo,
  }));
  for (let i = 0; i < blanks; i++) rows.push(empty(rows.length));
  return rows;
}

/**
 * Read the posted rows. Rows with neither code filled in are ignored, rows
 * marked for removal are dropped; the rest become mappings for the contract
 * to validate. Problems the contract cannot word well are reported here, by
 * row number as the person sees it.
 */
export function rowsFromForm(body: Form): { rows: MappingRow[]; mappings: TestMapping[]; issues: string[]; kept: number[] } {
  const count = Math.min(Number.parseInt(String(body['rowCount'] ?? '0'), 10) || 0, MAX_ROWS);
  const s = (k: string) => {
    const v = body[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  const rows: MappingRow[] = [];
  const mappings: TestMapping[] = [];
  const issues: string[] = [];
  const kept: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = `r${i}.`;
    const row: MappingRow = {
      n: i,
      localTestCode: s(`${p}local`),
      instrumentTestCode: s(`${p}code`),
      instrumentCodeSystem: s(`${p}system`),
      direction: s(`${p}direction`) || 'both',
      expectedUnits: s(`${p}units`),
      decimals: s(`${p}decimals`),
      qualitative: s(`${p}qual`),
      reportable: s(`${p}reportable`) === 'yes',
      ruo: s(`${p}ruo`) === 'yes',
      remove: s(`${p}remove`) === 'yes',
    };
    rows.push(row);
    if (row.remove || (!row.localTestCode && !row.instrumentTestCode)) continue;
    const label = `Row ${i + 1}`;
    if (!row.localTestCode) issues.push(`${label}: local test code is required`);
    if (!row.instrumentTestCode) issues.push(`${label}: instrument code is required`);
    let decimals: number | undefined;
    if (row.decimals) {
      decimals = /^\d$/.test(row.decimals) ? Number(row.decimals) : Number.NaN;
      if (Number.isNaN(decimals) || decimals > 6) issues.push(`${label}: decimals must be a whole number from 0 to 6`);
    }
    let qualitativeMap: Record<string, string> | undefined;
    if (row.qualitative) {
      qualitativeMap = {};
      for (const pair of row.qualitative.split(',').map((x) => x.trim()).filter(Boolean)) {
        const m = /^([^=]+)=(.+)$/.exec(pair);
        if (!m) {
          issues.push(`${label}: write qualitative codes as instrument=local, separated by commas (for example -1=NEG, 1=POS)`);
          break;
        }
        qualitativeMap[m[1]!.trim()] = m[2]!.trim();
      }
    }
    mappings.push({
      localTestCode: row.localTestCode,
      instrumentTestCode: row.instrumentTestCode,
      ...(row.instrumentCodeSystem ? { instrumentCodeSystem: row.instrumentCodeSystem } : {}),
      direction: row.direction as TestMapping['direction'],
      ...(row.expectedUnits ? { expectedUnits: row.expectedUnits } : {}),
      ...(decimals !== undefined && !Number.isNaN(decimals) ? { decimals } : {}),
      ...(qualitativeMap ? { qualitativeMap } : {}),
      reportable: row.reportable,
      ruo: row.ruo,
    });
    kept.push(i);
  }
  return { rows, mappings, issues, kept };
}

/** Contract issues name the list index ("3.expectedUnits: ..." or "mappings.3: ..."); say the row the person sees. */
export function issueForRows(issue: string, kept: number[]): string {
  return issue.replace(/^(?:mappings\.)?(\d+)(?:\.([\w.]+))?:\s*/, (_, idx: string, field: string | undefined) => `Row ${(kept[Number(idx)] ?? Number(idx)) + 1}${field ? ` ${field}` : ''}: `);
}
