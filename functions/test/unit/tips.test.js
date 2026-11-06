'use strict';

const {
  DEFAULT_COMMISSION_RATE,
  TIP_MIN,
  TIP_MAX,
  validateTipAmount,
  normalizeRate,
  computeApplicationFee,
  TIPS_TO_HOST_ENABLED,
  tipReturnUrl,
} = require('../../src/lib/tips');

describe('投げ銭ロジック (spec 002・Phase B)', () => {
  test('現時点では投げ銭は運営のみが受領する(主催者への分配は無効)', () => {
    expect(TIPS_TO_HOST_ENABLED).toBe(false);
  });

  describe('tipReturnUrl(決済後の戻り先)', () => {
    const base = 'https://qrbingo.web.app';
    test('許可したページへ戻る(ゲームなし)', () => {
      expect(tipReturnUrl(base, '/index.html', '', 'thanks')).toBe(`${base}/index.html?tip=thanks`);
      expect(tipReturnUrl(base, '/online/mypage.html', '', 'cancel')).toBe(`${base}/online/mypage.html?tip=cancel`);
    });
    test('プレイヤー画面はゲームコード付きで戻る', () => {
      expect(tipReturnUrl(base, '/online/player.html', 'ABCD', 'thanks')).toBe(
        `${base}/online/player.html?g=ABCD&tip=thanks`
      );
    });
    test('許可外・外部 URL はトップへ(オープンリダイレクト防止)', () => {
      expect(tipReturnUrl(base, 'https://evil.example/', '', 'thanks')).toBe(`${base}/index.html?tip=thanks`);
      expect(tipReturnUrl(base, '//evil.example', '', 'thanks')).toBe(`${base}/index.html?tip=thanks`);
      expect(tipReturnUrl(base, undefined, '', 'thanks')).toBe(`${base}/index.html?tip=thanks`);
    });
  });

  test('既定の運営手数料率は50%', () => {
    expect(DEFAULT_COMMISSION_RATE).toBe(0.5);
  });

  test('金額検証: 範囲内の整数のみ許可', () => {
    expect(validateTipAmount(100)).toEqual({ ok: true, value: 100 });
    expect(validateTipAmount(1000)).toEqual({ ok: true, value: 1000 });
    expect(validateTipAmount(TIP_MIN - 1).ok).toBe(false);
    expect(validateTipAmount(TIP_MAX + 1).ok).toBe(false);
    expect(validateTipAmount(100.5).ok).toBe(false);
    expect(validateTipAmount('abc').ok).toBe(false);
  });

  test('手数料率は 0〜0.9 に丸め、無効値は既定50%', () => {
    expect(normalizeRate(0.3)).toBe(0.3);
    expect(normalizeRate(0)).toBe(0);
    expect(normalizeRate(1.5)).toBe(0.5);
    expect(normalizeRate(-1)).toBe(0.5);
    expect(normalizeRate('x')).toBe(0.5);
    expect(normalizeRate(undefined)).toBe(0.5);
  });

  test('手数料額 = 金額 × 率(四捨五入)。既定50%でホストと折半', () => {
    expect(computeApplicationFee(1000, 0.5)).toBe(500);
    expect(computeApplicationFee(300, 0.5)).toBe(150);
    expect(computeApplicationFee(100, 0.5)).toBe(50);
    // 率30%
    expect(computeApplicationFee(1000, 0.3)).toBe(300);
    // 無効率は既定50%扱い
    expect(computeApplicationFee(1000, 'x')).toBe(500);
  });
});
