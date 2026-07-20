'use strict';

const {
  PLANS,
  priceIdForPlan,
  planFromPrice,
  PRICE_TO_PLAN_TEST,
} = require('../../src/lib/plans');

describe('課金プラン定義 (spec 002)', () => {
  test('4プランが定義されている(都度/年 × 300/1000)', () => {
    expect(Object.keys(PLANS).sort()).toEqual(
      ['annual_1000', 'annual_300', 'onetime_1000', 'onetime_300'].sort()
    );
  });

  test('都度は30日・年は365日', () => {
    expect(PLANS.onetime_300.durationDays).toBe(30);
    expect(PLANS.onetime_1000.durationDays).toBe(30);
    expect(PLANS.annual_300.durationDays).toBe(365);
    expect(PLANS.annual_1000.durationDays).toBe(365);
  });

  test('都度のみ複数月(multiMonth)を許可', () => {
    expect(PLANS.onetime_300.multiMonth).toBe(true);
    expect(PLANS.annual_300.multiMonth).toBe(false);
  });

  test('priceIdForPlan はテストモードで登録済み Price ID を返す', () => {
    const id = priceIdForPlan('onetime_300', false);
    expect(id).toBe('price_1Tv5Fm3fM9MR8XaqcH0ksLTZ');
    expect(PRICE_TO_PLAN_TEST[id]).toBe('onetime_300');
  });

  test('priceIdForPlan は本番未登録なら null', () => {
    expect(priceIdForPlan('onetime_300', true)).toBeNull();
  });

  test('planFromPrice はマップから付与内容を解決する', () => {
    const p = planFromPrice('price_1Tv5JR3fM9MR8XaqJJbgH4Vy', null, false);
    expect(p).toEqual({ maxPlayers: 1000, durationDays: 365, plan: 'annual_1000' });
  });

  test('planFromPrice は price.metadata を優先する(本番の setup-stripe 作成分)', () => {
    const p = planFromPrice('price_unknown_live', { maxPlayers: '500', durationDays: '90', kind: 'onetime' }, true);
    expect(p).toEqual({ maxPlayers: 500, durationDays: 90, plan: 'onetime' });
  });

  test('planFromPrice は未知の価格で null', () => {
    expect(planFromPrice('price_does_not_exist', null, false)).toBeNull();
    expect(planFromPrice('price_does_not_exist', {}, false)).toBeNull();
  });
});
