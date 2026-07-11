'use strict';

/*
 * QRBingo オンラインモード E2E(Phase 1: US-1/US-2/US-3 の受け入れシナリオ)
 *
 * 前提(quickstart.md 参照):
 *   1. リポジトリルートを静的サーバーで配信 (例: python3 -m http.server 8377)
 *   2. `firebase emulators:start --only firestore,auth,functions --project demo-qrbingo`
 *
 * 実行: STATIC_BASE_URL=http://localhost:8377/ node online-flow.test.js
 *      (省略時は http://localhost:8377/ を使用)
 *
 * Chromium の実行ファイルは環境変数 PW_CHROMIUM_PATH で上書きできる
 * (Claude Code on the web 環境では /opt/pw-browsers/chromium が既定)。
 */

const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

const BASE = process.env.STATIC_BASE_URL || 'http://localhost:8377/';
const CHROMIUM_PATH = process.env.PW_CHROMIUM_PATH || '/opt/pw-browsers/chromium';

function log(msg) {
  console.log('[e2e]', msg);
}

async function createOnlineGame(browser, settings = {}) {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 1000 } });
  const host = await ctx.newPage();
  await host.goto(BASE + 'online/host.html');
  await host.waitForSelector('#create-panel:not([hidden])', { timeout: 15000 });

  if (settings.winLines != null) await host.fill('#in-winlines', String(settings.winLines));
  if (settings.capacity != null) await host.fill('#in-capacity', String(settings.capacity));
  if (settings.prizeCount != null) await host.fill('#in-prizes', String(settings.prizeCount));
  if (settings.allowDuplicateCards) await host.check('#in-allowdup');

  await host.click('#create-btn');
  await host.waitForSelector('#lobby-panel:not([hidden])', { timeout: 15000 });

  const gameCode = (await host.textContent('#game-code')).trim();
  const joinUrl = (await host.textContent('#join-url')).trim();
  return { ctx, host, gameCode, joinUrl };
}

async function joinAsNewPlayer(browser, joinUrl, nickname) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(joinUrl);
  await page.waitForSelector('#nickname-panel:not([hidden]), #card td', { timeout: 15000 });
  const needsNickname = await page.evaluate(() => !document.getElementById('nickname-panel').hidden);
  if (needsNickname) {
    await page.fill('#in-nickname', nickname);
    await page.click('#nickname-btn');
    await page.waitForSelector('#card td', { timeout: 15000 });
  }
  return { ctx, page };
}

async function readGrid(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#card tbody tr'), (tr) =>
      Array.from(tr.querySelectorAll('td'), (td) => td.textContent)));
}

async function run() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  const opened = [];
  try {
    // ---------- US-1/US-2: ゲーム作成 + ロビー参加 ----------
    const { ctx: hostCtx, host, gameCode, joinUrl } = await createOnlineGame(browser, {
      winLines: 1,
      capacity: 10,
      prizeCount: 3,
    });
    opened.push(hostCtx);
    assert.match(gameCode, /^[A-Z0-9]{4}$/, 'gameCode should be a 4-char code');
    log(`game created: ${gameCode}`);

    const { ctx: p1Ctx, page: p1 } = await joinAsNewPlayer(browser, joinUrl, 'たろう');
    opened.push(p1Ctx);
    const p1Grid = await readGrid(p1);
    assert.equal(p1Grid.length, 5, 'grid should have 5 rows');
    log('player1 joined during lobby, card received');

    // ---------- US-3: 開始 + ゲーム中参加 ----------
    await host.click('#start-btn');
    await host.waitForSelector('#playing-panel:not([hidden])', { timeout: 15000 });
    log('game started');

    const { ctx: p2Ctx } = await joinAsNewPlayer(browser, BASE + `online/player.html?g=${gameCode}`, 'はなこ');
    opened.push(p2Ctx);
    log('player2 joined mid-game');

    // ---------- US-3: 抽選 + 自動マーキング ----------
    const targetNumbers = new Set();
    p1Grid.forEach((row) => row.forEach((v) => { if (v !== 'FREE') targetNumbers.add(Number(v)); }));

    let reachedBingo = false;
    for (let i = 0; i < 75; i++) {
      await host.waitForSelector('#draw-btn:not([disabled])', { timeout: 10000 });
      await host.click('#draw-btn');
      await host.waitForFunction(
        (n) => document.querySelectorAll('#history .chip').length === n,
        i + 1,
        { timeout: 8000 }
      );
      await p1.waitForTimeout(120); // realtime リスナー伝播待ち
      const banner = (await p1.textContent('#status-banner')).trim();
      if (banner.includes('ビンゴ')) {
        reachedBingo = true;
        log(`player1 reached bingo at draw #${i + 1}`);
        break;
      }
    }
    assert.ok(reachedBingo, 'player1 should reach bingo within 75 draws');

    const drawnNumbers = await host.evaluate(() =>
      Array.from(document.querySelectorAll('#history .chip'), (c) => Number(c.textContent)));
    assert.equal(new Set(drawnNumbers).size, drawnNumbers.length, 'no duplicate draws');

    // ---------- FR-013: セッション継続(リロード) ----------
    await p1.reload();
    await p1.waitForSelector('#card td', { timeout: 15000 });
    const p1GridAfterReload = await readGrid(p1);
    assert.deepEqual(p1GridAfterReload, p1Grid, 'card must be identical after reload');
    const bannerAfterReload = (await p1.textContent('#status-banner')).trim();
    assert.ok(bannerAfterReload.includes('ビンゴ'), 'bingo state should persist after reload');
    log('player1 session continuity OK (reload)');

    await host.reload();
    await host.waitForSelector('#playing-panel:not([hidden])', { timeout: 15000 });
    log('host session continuity OK (reload)');

    // ---------- FR-001: 定員の境界確認 ----------
    // 現在の参加者は 2 名(player1, player2)。capacity=10 なので、あと 8 名は参加でき、
    // 9 人目以降は拒否されるはず。
    const joinOutcomes = [];
    for (let i = 0; i < 10; i++) {
      const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
      const page = await ctx.newPage();
      try {
        await page.goto(BASE + `online/player.html?g=${gameCode}`);
        await page.waitForSelector('#nickname-panel:not([hidden]), #error-panel:not([hidden])', { timeout: 15000 });
        const rejectedAtProbe = await page.evaluate(() => !document.getElementById('error-panel').hidden);
        if (rejectedAtProbe) {
          joinOutcomes.push('rejected');
          continue;
        }
        await page.fill('#in-nickname', 'C' + i);
        await page.click('#nickname-btn');
        await page.waitForSelector('#card td, #error-panel:not([hidden])', { timeout: 15000 });
        const rejected = await page.evaluate(() => !document.getElementById('error-panel').hidden);
        joinOutcomes.push(rejected ? 'rejected' : 'joined');
      } finally {
        await ctx.close();
      }
    }
    const joinedCount = joinOutcomes.filter((r) => r === 'joined').length;
    const rejectedCount = joinOutcomes.filter((r) => r === 'rejected').length;
    assert.equal(joinedCount, 8, `expected 8 more joins to fill capacity=10, got ${joinedCount}`);
    assert.equal(rejectedCount, 2, `expected 2 rejections beyond capacity, got ${rejectedCount}`);
    log(`capacity enforcement OK (joined=${joinedCount}, rejected=${rejectedCount})`);

    log('ALL CHECKS PASSED');
  } finally {
    for (const ctx of opened) await ctx.close().catch(() => {});
    await browser.close();
  }
}

run().catch((e) => {
  console.error('[e2e] FAILED:', e);
  process.exitCode = 1;
});
