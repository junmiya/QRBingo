'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('./admin');
const { newGameId } = require('./lib/ids');
const { getEntitlement } = require('./lib/entitlements');

const DEFAULTS = {
  winLines: 1,
  revealDelaySec: 0,
  capacity: null,
  allowDuplicateCards: false,
  prizeCount: 3,
};

const MAX_GAME_ID_ATTEMPTS = 5;

// value が未指定なら fallback、指定されていれば [min,max] の整数であることを検証する。
// 範囲外は { ok:false } を返す(呼び出し側で HttpsError に変換)。
function parseIntSetting(value, min, max, fallback) {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return { ok: false };
  return { ok: true, value: n };
}

exports.createGame = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'サインインが必要です');
  }
  const input = request.data || {};

  const winLinesR = parseIntSetting(input.winLines, 1, 12, DEFAULTS.winLines);
  if (!winLinesR.ok) throw new HttpsError('invalid-argument', 'winLines は 1〜12 の整数で指定してください');

  const revealDelaySecR = parseIntSetting(input.revealDelaySec, 0, 60, DEFAULTS.revealDelaySec);
  if (!revealDelaySecR.ok) throw new HttpsError('invalid-argument', 'revealDelaySec は 0〜60 の整数で指定してください');

  // 課金プラン(entitlement)による参加人数上限の適用(spec 002・FR-M2)。
  // 無料は20人。有料/管理で上限が引き上げられる。上限超過の要求は拒否し、
  // capacity 未指定(=従来の無制限)はプラン上限に丸める(無料の無制限を禁止)。
  const entitlement = await getEntitlement(request.auth.uid);
  let capacity;
  if (input.capacity !== undefined && input.capacity !== null) {
    const capacityR = parseIntSetting(input.capacity, 1, 100000, undefined);
    if (!capacityR.ok) throw new HttpsError('invalid-argument', 'capacity は 1〜100000 の整数か null で指定してください');
    if (capacityR.value > entitlement.maxPlayers) {
      throw new HttpsError(
        'failed-precondition',
        `このプランの上限は ${entitlement.maxPlayers} 人です。より大人数にするにはアップグレードしてください`
      );
    }
    capacity = capacityR.value;
  } else {
    // 未指定は上限そのものを既定にする(無料でも最大20人まで参加可能)
    capacity = entitlement.maxPlayers;
  }

  const prizeCountR = parseIntSetting(input.prizeCount, 1, 100, DEFAULTS.prizeCount);
  if (!prizeCountR.ok) throw new HttpsError('invalid-argument', 'prizeCount は 1〜100 の整数で指定してください');

  const allowDuplicateCards = Boolean(input.allowDuplicateCards);

  // 投げ銭(Phase B): ホストが Connect 接続済み(受取可能)なら、このゲームで投げ銭を
  // 受け付ける。プレイヤー画面はこのフラグで投げ銭ボタンの表示可否を判断する。
  let tipsEnabled = false;
  try {
    const acct = await db.doc(`hostAccounts/${request.auth.uid}`).get();
    tipsEnabled = !!(acct.exists && acct.data().chargesEnabled);
  } catch (e) {
    tipsEnabled = false;
  }

  for (let attempt = 0; attempt < MAX_GAME_ID_ATTEMPTS; attempt++) {
    const gameId = newGameId();
    const ref = db.collection('games').doc(gameId);

    const created = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, {
        status: 'lobby',
        hostUid: request.auth.uid,
        settings: {
          winLines: winLinesR.value,
          revealDelaySec: revealDelaySecR.value,
          capacity,
          allowDuplicateCards,
          prizeCount: prizeCountR.value,
        },
        draws: [],
        participantCount: 0,
        reachCount: 0,
        tipsEnabled,
        tipTotalNet: 0,
        tipCount: 0,
        createdAt: FieldValue.serverTimestamp(),
        startedAt: null,
        finishedAt: null,
      });
      return true;
    });

    if (created) return { gameId };
  }

  throw new HttpsError('internal', 'ゲームIDの発行に失敗しました。もう一度お試しください');
});
