import { describe, expect, it } from 'vitest';
import { DEFAULT_DELIMITERS, components, escapeValue, field, parseTransfer, unescape } from '@lis/protocol-astm';

describe('E1394 records', () => {
  it('reads delimiters from the header and splits fields by ASTM position', () => {
    const { messages, errors } = parseTransfer('H|\\^&|||cobas-e411^1|||||host|TSREQ^REAL|P|1\rQ|1|^^000004^40^0^5^^S1^SC||ALL||||||||O\rL|1|N\r');
    expect(errors).toEqual([]);
    const [m] = messages;
    expect(m?.complete).toBe(true);
    const h = m!.records[0]!;
    expect(field(h, 2)).toBe('\\^&');
    expect(field(h, 5)).toBe('cobas-e411^1');
    expect(field(h, 10)).toBe('host');
    expect(field(h, 11)).toBe('TSREQ^REAL');
    const q = m!.records[1]!;
    expect(field(q, 13)).toBe('O');
    expect(components(field(q, 3), m!.delimiters)[2]).toBe('000004');
  });

  it('honours non-default delimiters declared in H', () => {
    const { messages } = parseTransfer('H!~@$\rO!1!AB@CD\rL!1\r');
    const m = messages[0]!;
    expect(m.delimiters).toEqual({ field: '!', repeat: '~', component: '@', escape: '$' });
    expect(components(field(m.records[1]!, 3), m.delimiters)).toEqual(['AB', 'CD']);
  });

  it('decodes escapes and nulls unknown escape sequences (E-4)', () => {
    const d = DEFAULT_DELIMITERS;
    expect(unescape('a&F&b&S&c&R&d&E&e', d)).toBe('a|b^c\\d&e');
    expect(unescape('x&Q&y', d)).toBe('xy');
    expect(unescape(escapeValue('a|b^c\\d&e', d), d)).toBe('a|b^c\\d&e');
  });

  it('reports records outside a message and unterminated messages', () => {
    const { messages, errors } = parseTransfer('R|1|x\rH|\\^&\rP|1\r');
    expect(errors).toContain('message not terminated by L record');
    expect(errors.some((e) => e.startsWith('record outside message'))).toBe(true);
    expect(messages[0]?.complete).toBe(false);
  });
});
