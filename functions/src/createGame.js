'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('./admin');
const { newGameId } = require('./lib/ids');

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

  let capacity = DEFAULTS.capacity;
  if (input.capacity !== undefined && input.capacity !== null) {
    const capacityR = parseIntSetting(input.capacity, 1, 100000, undefined);
    if (!capacityR.ok) throw new HttpsError('invalid-argument', 'capacity は 1〜100000 の整数か null で指定してください');
    capacity = capacityR.value;
  }

  const prizeCountR = parseIntSetting(input.prizeCount, 1, 100, DEFAULTS.prizeCount);
  if (!prizeCountR.ok) throw new HttpsError('invalid-argument', 'prizeCount は 1〜100 の整数で指定してください');

  const allowDuplicateCards = Boolean(input.allowDuplicateCards);

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
