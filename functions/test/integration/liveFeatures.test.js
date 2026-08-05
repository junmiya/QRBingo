'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { createGame } = require('../../src/createGame');
const { startGame } = require('../../src/startGame');
const { joinGame } = require('../../src/joinGame');
const { reportReach } = require('../../src/reportReach');
const { submitClaim } = require('../../src/submitClaim');
const { sendChat } = require('../../src/sendChat');
const { setChatEnabled, setCountdown, cancelGame } = require('../../src/gameOptions');
const { generateCard } = require('../../src/lib/bingo');
const { db } = require('../../src/admin');
const { uid } = require('./_helpers');

async function setDraws(gameId, numbers) {
  const draws = numbers.map((n, i) => ({
    n,
    ballIndex: i + 1,
    revealAt: Timestamp.fromMillis(Date.now() - 1000),
  }));
  await db.doc(`games/${gameId}`).update({ draws });
}

async function makeStartedGame(overrides = {}) {
  const host = uid();
  const { gameId } = await createGame.run({ data: overrides, auth: { uid: host } });
  await startGame.run({ data: { gameId }, auth: { uid: host } });
  return { gameId, host };
}

async function joinPlayer(gameId, nickname) {
  const player = uid();
  const res = await joinGame.run({ data: { gameId, nickname }, auth: { uid: player } });
  return { player, grid: generateCard(res.seed) };
}

async function feedDocs(gameId) {
  const snap = await db.collection(`games/${gameId}/feed`).get();
  return snap.docs.map((d) => d.data());
}

describe('リーチ/ビンゴの全員向けアナウンス feed (integration)', () => {
  test('初回リーチで feed に reach が1件追加される', async () => {
    const { gameId } = await makeStartedGame();
    const { player, grid } = await joinPlayer(gameId, 'リー子');
    await setDraws(gameId, grid[0].slice(0, 4)); // B列4マス → リーチ
    await reportReach.run({ data: { gameId }, auth: { uid: player } });

    const feed = await feedDocs(gameId);
    const reaches = feed.filter((f) => f.type === 'reach');
    expect(reaches.length).toBe(1);
    expect(reaches[0].nickname).toBe('リー子');
  });

  test('2回目以降のリーチ報告では feed が重複追加されない', async () => {
    const { gameId } = await makeStartedGame();
    const { player, grid } = await joinPlayer(gameId, 'リピ子');
    await setDraws(gameId, grid[0].slice(0, 4));
    await reportReach.run({ data: { gameId }, auth: { uid: player } });
    await reportReach.run({ data: { gameId }, auth: { uid: player } }); // 同状態の再送

    const reaches = (await feedDocs(gameId)).filter((f) => f.type === 'reach');
    expect(reaches.length).toBe(1);
  });

  test('ビンゴ成立で feed に bingo が追加される', async () => {
    const { gameId } = await makeStartedGame();
    const { player, grid } = await joinPlayer(gameId, 'ビン子');
    await setDraws(gameId, [...grid[0]]); // B列コンプリート → ビンゴ
    const res = await submitClaim.run({ data: { gameId }, auth: { uid: player } });
    expect(res.status).toBe('verified');

    const bingos = (await feedDocs(gameId)).filter((f) => f.type === 'bingo');
    expect(bingos.length).toBe(1);
    expect(bingos[0].nickname).toBe('ビン子');
  });
});

describe('チャット sendChat / setChatEnabled (integration)', () => {
  test('チャット無効のゲームでは送信できない(failed-precondition)', async () => {
    const { gameId } = await makeStartedGame(); // 既定は chatEnabled=false
    const { player } = await joinPlayer(gameId, 'チャ太');
    await expect(
      sendChat.run({ data: { gameId, text: 'こんにちは' }, auth: { uid: player } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('有効化すると参加者が送信でき、chat に保存される', async () => {
    const { gameId } = await makeStartedGame({ chatEnabled: true });
    const { player } = await joinPlayer(gameId, 'ハナ');
    const res = await sendChat.run({ data: { gameId, text: 'よろしく' }, auth: { uid: player } });
    expect(res.status).toBe('ok');

    const msgs = (await db.collection(`games/${gameId}/chat`).get()).docs.map((d) => d.data());
    expect(msgs.length).toBe(1);
    expect(msgs[0].nickname).toBe('ハナ');
    expect(msgs[0].text).toBe('よろしく');
    expect(msgs[0].isHost).toBe(false);
  });

  test('ホストは主催者名義で送信できる', async () => {
    const { gameId, host } = await makeStartedGame({ chatEnabled: true });
    await sendChat.run({ data: { gameId, text: '開始します' }, auth: { uid: host } });
    const msgs = (await db.collection(`games/${gameId}/chat`).get()).docs.map((d) => d.data());
    expect(msgs[0].isHost).toBe(true);
    expect(msgs[0].nickname).toBe('主催者');
  });

  test('未参加者(カード無し・非ホスト)は送信できない', async () => {
    const { gameId } = await makeStartedGame({ chatEnabled: true });
    await expect(
      sendChat.run({ data: { gameId, text: '乱入' }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('空文字は invalid-argument', async () => {
    const { gameId, host } = await makeStartedGame({ chatEnabled: true });
    await expect(
      sendChat.run({ data: { gameId, text: '   ' }, auth: { uid: host } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('setChatEnabled はホストのみ・設定が反映される', async () => {
    const { gameId, host } = await makeStartedGame();
    await setChatEnabled.run({ data: { gameId, enabled: true }, auth: { uid: host } });
    let game = (await db.doc(`games/${gameId}`).get()).data();
    expect(game.settings.chatEnabled).toBe(true);

    await expect(
      setChatEnabled.run({ data: { gameId, enabled: false }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
    game = (await db.doc(`games/${gameId}`).get()).data();
    expect(game.settings.chatEnabled).toBe(true); // 非ホストの変更は効かない
  });
});

describe('ゲーム中止 cancelGame (integration)', () => {
  test('ホストは lobby/playing のゲームを中止できる(status=expired)', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
    const res = await cancelGame.run({ data: { gameId }, auth: { uid: host } });
    expect(res.status).toBe('expired');
    const game = (await db.doc(`games/${gameId}`).get()).data();
    expect(game.status).toBe('expired');
  });

  test('非ホストは中止できない', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
    await expect(
      cancelGame.run({ data: { gameId }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('同時1ゲーム制限 (integration)', () => {
  test('進行中のゲームがあると新規作成は拒否される(failed-precondition)', async () => {
    const host = uid();
    await createGame.run({ data: {}, auth: { uid: host } });
    await expect(
      createGame.run({ data: {}, auth: { uid: host } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('終了(中止)すれば新しいゲームを作成できる', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
    await cancelGame.run({ data: { gameId }, auth: { uid: host } });
    const res2 = await createGame.run({ data: {}, auth: { uid: host } });
    expect(res2.gameId).toBeTruthy();
    expect(res2.gameId).not.toBe(gameId);
  });
});

describe('投げ銭の既定 (integration)', () => {
  test('投げ銭は常に有効。未接続ホストは tipsToHost=false(=100%運営)', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
    const game = (await db.doc(`games/${gameId}`).get()).data();
    expect(game.tipsEnabled).toBe(true);
    expect(game.tipsToHost).toBe(false);
  });
});

describe('カウントダウン setCountdown (integration)', () => {
  test('ホストが秒を指定すると countdownTarget が未来に設定される', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: { countdownEnabled: true }, auth: { uid: host } });
    const res = await setCountdown.run({ data: { gameId, seconds: 120 }, auth: { uid: host } });
    expect(res.countdownTarget).toBeGreaterThan(Date.now());

    const game = (await db.doc(`games/${gameId}`).get()).data();
    expect(game.settings.countdownEnabled).toBe(true);
    expect(game.countdownTarget).not.toBeNull();
  });

  test('seconds=0 で目標が解除される', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
    await setCountdown.run({ data: { gameId, seconds: 60 }, auth: { uid: host } });
    await setCountdown.run({ data: { gameId, seconds: 0 }, auth: { uid: host } });
    const game = (await db.doc(`games/${gameId}`).get()).data();
    expect(game.countdownTarget).toBeNull();
    expect(game.settings.countdownEnabled).toBe(false);
  });

  test('範囲外(3601秒)は invalid-argument', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
    await expect(
      setCountdown.run({ data: { gameId, seconds: 3601 }, auth: { uid: host } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('非ホストは操作できない', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
    await expect(
      setCountdown.run({ data: { gameId, seconds: 60 }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
