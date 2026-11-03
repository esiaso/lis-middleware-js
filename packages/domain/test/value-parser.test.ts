import { describe, expect, it } from 'vitest';
import { canonicalDecimal, parseNumericField } from '@lis/domain';

describe('parseNumericField', () => {
  it.each([
    ['0.310', { kind: 'numeric', value: '0.310', scale: 3 }],
    ['+1.25', { kind: 'numeric', value: '1.25', scale: 2 }],
    ['-1', { kind: 'numeric', value: '-1', scale: 0 }],
    ['007.50', { kind: 'numeric', value: '7.50', scale: 2 }],
    ['.5', { kind: 'numeric', value: '0.5', scale: 1 }],
    ['-0.00', { kind: 'numeric', value: '0.00', scale: 2 }],
    ['<0.01', { kind: 'censored', comparator: '<', limit: '0.01' }],
    ['>1000', { kind: 'censored', comparator: '>', limit: '1000' }],
    ['<= 5', { kind: 'censored', comparator: '<=', limit: '5' }],
    ['       ', { kind: 'absent', reason: 'no-result' }],
    ['', { kind: 'absent', reason: 'no-result' }],
    ['***.**', { kind: 'absent', reason: 'masked' }],
    ['POS', { kind: 'text', text: 'POS' }],
    ['1.2.3', { kind: 'text', text: '1.2.3' }],
    ['<abc', { kind: 'text', text: '<abc' }],
  ])('%j', (input, expected) => {
    expect(parseNumericField(input)).toEqual(expected);
  });

  it('never goes through floating point', () => {
    expect(canonicalDecimal('0.30000000000000000000001')?.value).toBe('0.30000000000000000000001');
    expect(canonicalDecimal('12345678901234567890.1')?.value).toBe('12345678901234567890.1');
  });
});
