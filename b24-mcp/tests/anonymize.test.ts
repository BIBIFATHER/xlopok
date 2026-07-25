import { describe, expect, it } from 'vitest';
import { anonymize } from '../src/validation/anonymize.js';
import { shapeOf } from '../src/validation/live-readonly.js';

describe('fixture anonymisation', () => {
  it('replaces names, phones and emails but keeps structure', () => {
    const input = {
      id: 42,
      title: 'ООО "Секретная Компания"',
      phone: [{ VALUE: '+7 916 111-22-33', VALUE_TYPE: 'WORK' }],
      email: [{ VALUE: 'buyer@real-client.ru', VALUE_TYPE: 'WORK' }],
      stageId: 'C0:NEW',
    };
    const out = anonymize(input) as any;

    expect(out.id).toBe(42);
    expect(out.stageId).toBe('C0:NEW');
    expect(out.title).not.toContain('Секретная');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('9161112233');
    expect(serialized).not.toContain('real-client');
    expect(out.phone[0].VALUE_TYPE).toBe('WORK'); // type metadata preserved
  });

  it('is stable — the same input yields the same pseudonym', () => {
    const a = anonymize({ title: 'ООО Ромашка' }) as any;
    const b = anonymize({ title: 'ООО Ромашка' }) as any;
    expect(a.title).toBe(b.title);
  });

  it('scrubs contacts embedded in free text', () => {
    const out = anonymize({
      comments: 'Звонить на +7 916 111-22-33 или писать buyer@real-client.ru',
    }) as any;
    expect(out.comments).not.toContain('9161112233');
    expect(out.comments).not.toContain('real-client.ru');
  });

  it('does not corrupt ISO dates or numeric ids', () => {
    const out = anonymize({
      id: 100,
      createdTime: '2026-06-15T09:00:00+03:00',
      deadline: '2026-06-01T06:00:00.000Z',
      opportunity: 120000,
    }) as any;
    expect(out.id).toBe(100);
    expect(out.opportunity).toBe(120000);
    expect(out.createdTime).toBe('2026-06-15T09:00:00+03:00');
    expect(out.deadline).toBe('2026-06-01T06:00:00.000Z');
  });

  it('handles nested arrays and objects', () => {
    const out = anonymize({
      items: [{ name: 'Иван', phone: [{ VALUE: '89161112233' }] }],
    }) as any;
    expect(out.items[0].name).toMatch(/Контакт-/);
    expect(JSON.stringify(out)).not.toContain('89161112233');
  });
});

describe('shapeOf', () => {
  it('reports keys and types, never values', () => {
    const shape = shapeOf({ id: 1, title: 'secret', tags: ['a', 'b'] }) as any;
    expect(shape).toEqual({ id: 'number', title: 'string', tags: ['string'] });
  });
});
