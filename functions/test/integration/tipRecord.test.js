'use strict';

const { createGame } = require('../../src/createGame');
const { joinGame } = require('../../src/joinGame');
const { recordTip } = require('../../src/lib/tipRecord');
const { db } = require('../../src/admin');
const { uid } = require('./_helpers');

const session = (id, metadata) => ({ id, amount_total: Number(metadata.amount), metadata: { kind: 'tip', ...metadata } });
const feedTips = async (gameId) =>
  (await db.collection(`games/${gameId}/feed`).get()).docs.map((d) => d.data()).filter((f) => f.type === 'tip');

describe('投げ銭の記録 recordTip (integration)', () => {
  test('ゲームなしの投げ銭も運営の台帳に記録される', async () => {
    const id = 'cs_test_nogame_' + uid();
    const from = uid();
    expect(await recordTip(session(id, { amount: '500', fee: '500', fromUid: from }))).toBe('ok');
    const ledger = (await db.doc(`operatorTips/${id}`).get()).data();
    expect(ledger).toMatchObject({ amount: 500, fee: 500, net: 0, gameId: null, fromUid: from });
    expect((await db.doc(`stripeEvents/${id}`).get()).data().kind).toBe('tip');
  });

  test('ゲームからの投げ銭は台帳+ゲームに記録し、全員にアナウンス', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
    const player = uid();
    await joinGame.run({ data: { gameId, nickname: 'たろう' }, auth: { uid: player } });
    const id = 'cs_test_game_' + uid();
    await recordTip(session(id, { amount: '300', fee: '300', gameId, hostUid: host, fromUid: player }));

    expect((await db.doc(`operatorTips/${id}`).get()).data()).toMatchObject({ amount: 300, gameId });
    expect((await db.doc(`games/${gameId}/tips/${id}`).get()).exists).toBe(true);
    const game = (await db.doc(`games/${gameId}`).get()).data();
    expect(game.tipCount).toBe(1);
    expect(game.tipTotalAmount).toBe(300);
    expect(game.tipTotalNet).toBe(0); // 全額が運営
    expect(await feedTips(gameId)).toEqual([expect.objectContaining({ type: 'tip', nickname: 'たろう', amount: 300 })]);
  });

  test('参加していない視聴者の投げ銭は「応援」名でアナウンス', async () => {
    const { gameId } = await createGame.run({ data: {}, auth: { uid: uid() } });
    await recordTip(session('cs_test_viewer_' + uid(), { amount: '100', fee: '100', gameId, fromUid: uid() }));
    expect(await feedTips(gameId)).toEqual([expect.objectContaining({ nickname: '応援', amount: 100 })]);
  });

  test('Webhook の二重配信は無視(集計もアナウンスも1回)', async () => {
    const { gameId } = await createGame.run({ data: {}, auth: { uid: uid() } });
    const s = session('cs_test_dup_' + uid(), { amount: '1000', fee: '1000', gameId, fromUid: uid() });
    expect(await recordTip(s)).toBe('ok');
    expect(await recordTip(s)).toBe('duplicate');
    const game = (await db.doc(`games/${gameId}`).get()).data();
    expect(game.tipCount).toBe(1);
    expect(game.tipTotalAmount).toBe(1000);
    expect((await feedTips(gameId)).length).toBe(1);
  });
});
