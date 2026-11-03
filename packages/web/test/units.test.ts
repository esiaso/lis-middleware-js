import { describe, expect, it } from 'vitest';
import { hashPassword, parseEnteredValue, safeNext, validatePassword, verifyPassword } from '@lis/web';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterz', h)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });

  it('asks for at least 12 characters', () => {
    expect(validatePassword('short')).toMatch(/12/);
    expect(validatePassword('long enough pass')).toBeUndefined();
  });
});

describe('post-login redirect', () => {
  it('only allows local paths', () => {
    expect(safeNext('/results?status=reviewed')).toBe('/results?status=reviewed');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/results"><script>')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
});

describe('entered correction values', () => {
  it('keeps decimals as strings with their reported scale', () => {
    expect(parseEnteredValue('1.50')).toEqual({ kind: 'numeric', value: '1.50', scale: 2 });
    expect(parseEnteredValue('12')).toEqual({ kind: 'numeric', value: '12', scale: 0 });
  });
  it('reads censored values', () => {
    expect(parseEnteredValue('< 0.005')).toEqual({ kind: 'censored', comparator: '<', limit: '0.005' });
    expect(parseEnteredValue('>=1000')).toEqual({ kind: 'censored', comparator: '>=', limit: '1000' });
  });
  it('treats anything else as text, and blank as nothing', () => {
    expect(parseEnteredValue('haemolysed')).toEqual({ kind: 'text', text: 'haemolysed' });
    expect(parseEnteredValue('  ')).toBeUndefined();
  });
});
