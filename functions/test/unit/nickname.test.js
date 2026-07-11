'use strict';

const { validateNickname, MAX_LEN, MIN_LEN } = require('../../src/lib/nickname');

describe('lib/nickname', () => {
  test('accepts a normal Japanese nickname', () => {
    expect(validateNickname('たろう')).toEqual({ ok: true, nickname: 'たろう' });
  });

  test('trims surrounding whitespace', () => {
    expect(validateNickname('  たろう  ')).toEqual({ ok: true, nickname: 'たろう' });
  });

  test('rejects empty string', () => {
    expect(validateNickname('')).toEqual({ ok: false, reason: 'length' });
  });

  test(`rejects strings longer than ${MAX_LEN}`, () => {
    expect(validateNickname('a'.repeat(MAX_LEN + 1))).toEqual({ ok: false, reason: 'length' });
  });

  test('accepts MIN_LEN/MAX_LEN boundary lengths', () => {
    expect(validateNickname('a'.repeat(MIN_LEN)).ok).toBe(true);
    expect(validateNickname('a'.repeat(MAX_LEN)).ok).toBe(true);
  });

  test('rejects default NG words case-insensitively', () => {
    expect(validateNickname('admin').ok).toBe(false);
    expect(validateNickname('Admin').ok).toBe(false);
    expect(validateNickname('ホスト').ok).toBe(false);
  });

  test('rejects control characters', () => {
    const withNull = 'abc' + String.fromCharCode(0) + 'def';
    expect(validateNickname(withNull)).toEqual({ ok: false, reason: 'control_chars' });
  });

  test('custom ngWords overrides the default list entirely', () => {
    expect(validateNickname('admin', ['x'])).toEqual({ ok: true, nickname: 'admin' });
    expect(validateNickname('xavier', ['x']).ok).toBe(false);
  });
});
