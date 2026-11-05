import { describe, expect, it } from 'vitest';
import { answersText, loincCheckDigitOk, parseAnswers, parseCatalogueForm, readManualValue, type CatalogueDefinition, type CatalogueForm } from '@lis/domain';

// Codes below are examples for the tests only; the lab chooses its own from the LOINC release the HMIS uses.
const form = (over: Partial<CatalogueForm> = {}): CatalogueForm => ({
  localCode: 'mal-rdt', name: 'Malaria rapid test', section: 'Parasitology', loincCode: '', loincDisplay: '', shaCode: '', specimenType: 'Blood',
  performedBy: 'MANUAL', resultType: 'NOMINAL', answers: 'NEG | Negative\nPF | P. falciparum positive | abnormal\nINV | Invalid', unit: '', decimals: '', ...over,
});

describe('LOINC check digit', () => {
  it.each(['3016-3', '718-7', '2345-7', '2160-0', '24356-8', '5811-5', '13945-1'])('accepts %s', (c) => expect(loincCheckDigitOk(c)).toBe(true));
  it.each(['3016-4', '718-1', '24356-3', 'x-1', '3016'])('refuses %s', (c) => expect(loincCheckDigitOk(c)).toBe(false));
});

describe('catalogue form', () => {
  it('reads a choice test and upper-cases the code', () => {
    const p = parseCatalogueForm(form());
    expect(p).toMatchObject({ ok: true, value: { localCode: 'MAL-RDT', resultType: 'NOMINAL', answers: [{ code: 'NEG', display: 'Negative' }, { code: 'PF', abnormal: true }, { code: 'INV' }] } });
  });

  it('catches a mistyped LOINC code by its check digit', () => {
    expect(parseCatalogueForm(form({ loincCode: '3016-4' }))).toEqual({ ok: false, issues: ['3016-4 fails the LOINC check digit. Check it against the LOINC release the HMIS uses.'] });
    expect(parseCatalogueForm(form({ loincCode: 'TSH' }))).toMatchObject({ ok: false, issues: ['A LOINC code looks like 3016-3.'] });
  });

  it('needs at least two answers for a choice, and none for a number', () => {
    expect(parseCatalogueForm(form({ answers: 'POS | Positive' }))).toMatchObject({ ok: false, issues: ['A choice result needs at least two answers, one per line.'] });
    expect(parseCatalogueForm(form({ resultType: 'NUMERIC' }))).toMatchObject({ ok: false, issues: ['Only ordinal and nominal results have an answer list.'] });
    expect(parseCatalogueForm(form({ resultType: 'NUMERIC', answers: '', unit: '/uL', decimals: '0' }))).toMatchObject({ ok: true, value: { unit: '/uL', decimals: 0, answers: [] } });
    expect(parseCatalogueForm(form({ unit: 'g/L' }))).toMatchObject({ ok: false, issues: ['Only a numeric result has a unit.'] });
  });

  it('reads a panel as its component codes, and refuses a short or odd list', () => {
    const panel = { resultType: 'PANEL', answers: '', localCode: 'UA', components: 'u-prot, U-GLU\nU-RBC' };
    expect(parseCatalogueForm(form(panel))).toMatchObject({ ok: true, value: { resultType: 'PANEL', components: ['U-PROT', 'U-GLU', 'U-RBC'] } });
    expect(parseCatalogueForm(form({ ...panel, components: 'U-PROT' }))).toMatchObject({ ok: false, issues: ['A panel lists at least two component tests by their local codes.'] });
    expect(parseCatalogueForm(form({ ...panel, components: 'UA U-PROT U-PROT' }))).toMatchObject({ ok: false, issues: ['Listed twice: U-PROT.', 'A panel cannot list itself.'] });
    expect(parseCatalogueForm(form({ components: 'U-PROT U-GLU' }))).toMatchObject({ ok: false, issues: ['Only a panel has component tests.'] });
  });

  it('refuses bad answer lines and keeps a LOINC answer code', () => {
    const r = parseAnswers('NEG | Negative | LA6577-6\nPOS\nNEG | again\nX | Y | maybe');
    expect(r.answers[0]).toEqual({ code: 'NEG', display: 'Negative', loinc: 'LA6577-6' });
    expect(r.issues).toEqual([
      'Answer 2: give the words to show, up to 80 characters, after a | sign.',
      'Answer 3: the code NEG is used twice.',
      'Answer 4: "maybe" is neither "abnormal" nor a LOINC answer code (LA...).',
    ]);
    expect(answersText(r.answers.slice(0, 1))).toBe('NEG | Negative | LA6577-6');
  });
});

describe('a value typed on the worksheet', () => {
  const choice: CatalogueDefinition = { localCode: 'U-PROT', name: 'Urine protein (dipstick)', section: 'Urinalysis', performedBy: 'MANUAL', resultType: 'ORDINAL', answers: [{ code: 'NEG', display: 'Negative' }, { code: 'TR', display: 'Trace' }, { code: '1+', display: '1+', abnormal: true }] };
  const count: CatalogueDefinition = { localCode: 'MAL-DENS', name: 'Parasite density', section: 'Parasitology', performedBy: 'MANUAL', resultType: 'NUMERIC', answers: [], unit: '/uL', decimals: 0 };

  it('never takes an empty field as normal', () => {
    expect(readManualValue(choice, '  ')).toEqual({ ok: false, issue: 'Enter a result. An empty field is never taken as normal.' });
  });
  it('takes only an answer from the list, and flags an abnormal one', () => {
    expect(readManualValue(choice, 'NEG')).toEqual({ ok: true, value: { kind: 'qualitative', code: 'NEG' }, abnormalFlags: [] });
    expect(readManualValue(choice, '1+')).toEqual({ ok: true, value: { kind: 'qualitative', code: '1+' }, abnormalFlags: ['A'] });
    expect(readManualValue(choice, 'Positive')).toEqual({ ok: false, issue: 'Pick one of the answers for Urine protein (dipstick).' });
  });
  it('reads numbers as decimal strings with the catalogue unit, and holds to its decimals', () => {
    expect(readManualValue(count, '012400')).toEqual({ ok: true, value: { kind: 'numeric', value: '12400', scale: 0 }, units: '/uL', abnormalFlags: [] });
    expect(readManualValue(count, '< 50')).toEqual({ ok: true, value: { kind: 'censored', comparator: '<', limit: '50' }, units: '/uL', abnormalFlags: [] });
    expect(readManualValue(count, '12.5')).toEqual({ ok: false, issue: 'Parasite density is reported with no decimals.' });
    expect(readManualValue(count, 'many')).toMatchObject({ ok: false });
  });
});
