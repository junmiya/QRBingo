'use strict';

const { db } = require('../../src/admin');

function uid() {
  return 'uid-' + Math.random().toString(36).slice(2, 10);
}

// テスト用: ホストに大きめの人数上限 entitlement を付与する。
// 課金ゲート導入前の「無制限ホスト」相当の挙動を保つため、ゲーム作成系ヘルパーで使う。
// (課金ゲート自体は entitlements.test.js で個別に検証する)
async function grantEntitlement(hostUid, maxPlayers = 100000) {
  await db.doc(`entitlements/${hostUid}`).set({
    maxPlayers,
    plan: 'test',
    source: 'admin',
    validUntil: null,
  });
}

module.exports = { uid, grantEntitlement };
