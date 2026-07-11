'use strict';

const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('./admin');
const { newCardSeedSuffix } = require('./lib/ids');
const { generateCard } = require('./lib/bingo');
const { validateNickname } = require('./lib/nickname');

const MAX_SEED_ATTEMPTS = 5;

class SeedCollisionError extends Error {}

// grid[col][row] を正規化した文字列の SHA-256。同一ゲーム内の
// カード重複排除キーとして使う(FR-004)。
function gridHash(grid) {
  const flat = grid.map((col) => col.join(',')).join('|');
  return crypto.createHash('sha256').update(flat).digest('hex');
}

exports.joinGame = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'サインインが必要です');
  }
  const uid = request.auth.uid;
  const input = request.data || {};
  const gameId = String(input.gameId || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');

  const gameRef = db.collection('games').doc(gameId);
  const cardId = `${gameId}_${uid}`;
  const cardRef = db.collection('cards').doc(cardId);

  // 冪等: 既に参加済みなら既存カードをそのまま返す(セッション復帰 FR-013)。
  // ゲームの状態に関わらず、発行済みカードへのアクセスは常に許可する。
  const existing = await cardRef.get();
  if (existing.exists) {
    const c = existing.data();
    return { cardId, seed: c.seed, nickname: c.nickname, rejoined: true };
  }

  const nickResult = validateNickname(input.nickname);
  if (!nickResult.ok) {
    throw new HttpsError('invalid-argument', 'ニックネームが不正です: ' + nickResult.reason);
  }

  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
  const initialGame = gameSnap.data();
  if (initialGame.status === 'finished' || initialGame.status === 'expired') {
    throw new HttpsError('failed-precondition', 'このゲームは終了しています');
  }

  for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS; attempt++) {
    const seed = `${gameId}-${newCardSeedSuffix()}`;
    const grid = generateCard(seed);
    const hash = gridHash(grid);
    const hashRef = gameRef.collection('gridHashes').doc(hash);

    try {
      await db.runTransaction(async (tx) => {
        const gameTxSnap = await tx.get(gameRef);
        const cardTxSnap = await tx.get(cardRef);
        const hashTxSnap = initialGame.settings.allowDuplicateCards ? null : await tx.get(hashRef);

        if (cardTxSnap.exists) {
          // 並行リクエストで既に作成済み。何もせず成功扱い(呼び出し元で再取得)。
          return;
        }

        const g = gameTxSnap.data();
        if (!g) throw new HttpsError('not-found', 'ゲームが見つかりません');
        if (g.status === 'finished' || g.status === 'expired') {
          throw new HttpsError('failed-precondition', 'このゲームは終了しています');
        }
        if (g.settings.capacity != null && g.participantCount >= g.settings.capacity) {
          throw new HttpsError('resource-exhausted', '定員に達しました');
        }
        if (!g.settings.allowDuplicateCards) {
          if (hashTxSnap.exists) throw new SeedCollisionError();
          tx.set(hashRef, { cardId });
        }

        tx.set(cardRef, {
          gameId,
          uid,
          seed,
          gridHash: hash,
          nickname: nickResult.nickname,
          nicknameHidden: false,
          createdAt: FieldValue.serverTimestamp(),
        });
        tx.update(gameRef, { participantCount: FieldValue.increment(1) });
      }, { maxAttempts: 10 });
      // 参加は最も競合が集中する操作(TV放送でQR表示直後の一斉アクセス、NFR-001)
      // のため、既定の再試行回数(5)では取りこぼす恐れがあり余裕を持たせている。

      const saved = await cardRef.get();
      const c = saved.data();
      return { cardId, seed: c.seed, nickname: c.nickname, rejoined: false };
    } catch (err) {
      if (err instanceof SeedCollisionError) continue; // 別シードで再試行
      throw err;
    }
  }

  throw new HttpsError('internal', 'カードの発行に失敗しました。もう一度お試しください');
});
