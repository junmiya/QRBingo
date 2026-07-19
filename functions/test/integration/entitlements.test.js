'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { createGame } = require('../../src/createGame');
const { joinGame } = require('../../src/joinGame');
const { db } = require('../../src/admin');
const { uid } = require('./_helpers');

// entitlement を直接書き込む(本番は Stripe Webhook / 運営がこれを行う)
async function setEntitlement(hostUid, data) {
  await db.doc(`entitlements/${hostUid}`).set(data);
}

describe('課金プランによる人数ゲート (integration・spec 002)', () => {
  test('無料(entitlement 未設定)は capacity 上限20。未指定は20に丸まる', async () => {
    const res = await createGame.run({ data: {}, auth: { uid: uid() } });
    const game = (await db.doc(`games/${res.gameId}`).get()).data();
    expect(game.settings.capacity).toBe(20);
  });

  test('無料で capacity 21 を要求すると failed-precondition(アップグレード導線)', async () => {
    await expect(
      createGame.run({ data: { capacity: 21 }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('無料で capacity 20 ちょうどは許可', async () => {
    const res = await createGame.run({ data: { capacity: 20 }, auth: { uid: uid() } });
    const game = (await db.doc(`games/${res.gameId}`).get()).data();
    expect(game.settings.capacity).toBe(20);
  });

  test('有料 entitlement(300人)を付与すると capacity 300 まで許可', async () => {
    const host = uid();
    await setEntitlement(host, { maxPlayers: 300, plan: 'onetime300', source: 'stripe', validUntil: null });
    const res = await createGame.run({ data: { capacity: 300 }, auth: { uid: host } });
    const game = (await db.doc(`games/${res.gameId}`).get()).data();
    expect(game.settings.capacity).toBe(300);
    // 上限超過(301)は拒否
    await expect(
      createGame.run({ data: { capacity: 301 }, auth: { uid: host } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('有料 entitlement で capacity 未指定なら上限(300)が既定になる', async () => {
    const host = uid();
    await setEntitlement(host, { maxPlayers: 300, plan: 'onetime300', source: 'stripe', validUntil: null });
    const res = await createGame.run({ data: {}, auth: { uid: host } });
    const game = (await db.doc(`games/${res.gameId}`).get()).data();
    expect(game.settings.capacity).toBe(300);
  });

  test('有効期限切れの entitlement は無料(20)に戻る', async () => {
    const host = uid();
    await setEntitlement(host, {
      maxPlayers: 1000,
      plan: 'onetime1000',
      source: 'stripe',
      validUntil: Timestamp.fromMillis(Date.now() - 1000), // 過去
    });
    // 期限切れなので capacity 100 は拒否(無料上限20に戻る)
    await expect(
      createGame.run({ data: { capacity: 100 }, auth: { uid: host } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    const res = await createGame.run({ data: {}, auth: { uid: host } });
    const game = (await db.doc(`games/${res.gameId}`).get()).data();
    expect(game.settings.capacity).toBe(20);
  });

  test('ゲートは実際の参加人数も制限する(無料20人で21人目は入れない)', async () => {
    const res = await createGame.run({ data: {}, auth: { uid: uid() } });
    const gameId = res.gameId;
    await db.doc(`games/${gameId}`).update({ status: 'playing' });
    // 20人は参加できる
    for (let i = 0; i < 20; i++) {
      await joinGame.run({ data: { gameId, nickname: 'P' + i }, auth: { uid: uid() } });
    }
    // 21人目は定員(20)で拒否
    await expect(
      joinGame.run({ data: { gameId, nickname: 'P21' }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
  }, 30000);
});
