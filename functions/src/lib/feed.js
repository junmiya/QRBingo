'use strict';

// リーチ/ビンゴの全員向けアナウンス(feed)。
// games/{gameId}/feed/{autoId} に追記し、全参加者が購読して画面に流す。
// コスト特性: 1イベントにつき参加者数ぶんの read が発生するため、リーチは
// 「各プレイヤーの初回のみ」に限定して件数を抑える(呼び出し側で制御)。
// 順位・当選には一切影響しない演出専用データ。

const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('../admin');

// 直近アナウンスの取りこぼしを避けつつ肥大化を防ぐため、feed は追記のみ。
// クライアントは createdAt 降順・件数制限で購読する。
async function appendFeed(gameId, event) {
  try {
    await db.collection(`games/${gameId}/feed`).add({
      type: event.type, // 'reach' | 'bingo'
      nickname: event.nickname || '',
      ballIndex: event.ballIndex || 0,
      reachLines: event.reachLines || 0,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    // アナウンスは演出であり、失敗してもゲーム進行に影響させない
  }
}

module.exports = { appendFeed };
