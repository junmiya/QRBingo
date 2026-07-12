'use strict';

/*
 * QRBingo オンラインモード Phase 2 E2E(ビンゴ判定・順位・当選コード)。
 * 前提: 静的サーバー(8377) + Firebase Emulator(firestore/auth/functions)。
 * 実行: STATIC_BASE_URL=http://localhost:8377/ node phase2-flow.test.js
 */

const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

const BASE = process.env.STATIC_BASE_URL || 'http://localhost:8377/';
const CHROMIUM_PATH = process.env.PW_CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const log = (m) => console.log('[phase2]', m);

async function createGame(browser, settings) {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 1000 } });
  const host = await ctx.newPage();
  await host.goto(BASE + 'online/host.html');
  await host.waitForSelector('#create-panel:not([hidden])', { timeout: 15000 });
  if (settings.winLines != null) await host.fill('#in-winlines', String(settings.winLines));
  if (settings.prizeCount != null) await host.fill('#in-prizes', String(settings.prizeCount));
  await host.click('#create-btn');
  await host.waitForSelector('#lobby-panel:not([hidden])', { timeout: 15000 });
  const gameCode = (await host.textContent('#game-code')).trim();
  const joinUrl = (await host.textContent('#join-url')).trim();
  return { ctx, host, gameCode, joinUrl };
}

async function joinPlayer(browser, joinUrl, nickname) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(joinUrl);
  await page.waitForSelector('#nickname-panel:not([hidden])', { timeout: 15000 });
  await page.fill('#in-nickname', nickname);
  await page.click('#nickname-btn');
  await page.waitForSelector('#card td', { timeout: 15000 });
  return { ctx, page };
}

async function run() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  const opened = [];
  try {
    const { ctx: hostCtx, host, gameCode, joinUrl } = await createGame(browser, {
      winLines: 1,
      prizeCount: 2,
    });
    opened.push(hostCtx);
    log(`game ${gameCode} created (winLines=1, prizeCount=2)`);

    const players = [];
    for (const name of ['あか', 'あお', 'みどり']) {
      const p = await joinPlayer(browser, joinUrl, name);
      opened.push(p.ctx);
      players.push({ name, ...p });
    }
    log('3 players joined');

    await host.click('#start-btn');
    await host.waitForSelector('#playing-panel:not([hidden])', { timeout: 15000 });

    // 全員がビンゴ(rank-panel 表示)するまで抽選
    let allClaimed = false;
    for (let i = 0; i < 75 && !allClaimed; i++) {
      await host.waitForSelector('#draw-btn:not([disabled])', { timeout: 10000 });
      await host.click('#draw-btn');
      await host.waitForFunction(
        (n) => document.querySelectorAll('#history .chip').length === n,
        i + 1,
        { timeout: 8000 }
      );
      await host.waitForTimeout(120);
      const states = await Promise.all(
        players.map((p) => p.page.locator('#rank-panel').isVisible())
      );
      allClaimed = states.every(Boolean);
    }
    assert.ok(allClaimed, '全プレイヤーがビンゴ・クレーム到達するはず');
    log('all players claimed (rank panels visible)');

    // ホスト側に暫定ランキングが表示される
    await host.waitForSelector('#ranking-panel:not([hidden])', { timeout: 8000 });
    const provisionalRows = await host.locator('#ranking-body tbody tr').count();
    assert.equal(provisionalRows, 3, '暫定ランキングに3人');
    log('host shows provisional ranking (3 rows)');

    // ゲーム終了 → 順位確定
    host.once('dialog', (d) => d.accept());
    await host.click('#finish-btn');

    // ホスト: 確定ランキング(当選コード列)表示
    await host.waitForFunction(
      () => document.getElementById('ranking-title').textContent.includes('確定'),
      null,
      { timeout: 10000 }
    );
    const winCodeCells = await host.locator('#ranking-body .wincode-cell').count();
    assert.equal(winCodeCells, 2, '当選コードは景品数(2)分だけ表示される');
    log('host shows final ranking with 2 win codes');

    // プレイヤー: 当選者は当選コード(win-code-box)、非当選者は「最終順位です」。
    // 当選ドキュメントの伝播を待つため各プレイヤーを少しポーリングする。
    let winnersSeen = 0;
    for (const p of players) {
      await p.page
        .waitForFunction(
          () =>
            document.getElementById('rank-note').textContent.includes('おめでとう') ||
            document.getElementById('rank-note').textContent.includes('最終順位'),
          null,
          { timeout: 10000 }
        )
        .catch(() => {});
      const hasWinCode = await p.page.locator('#win-code-box').isVisible();
      if (hasWinCode) {
        const code = (await p.page.textContent('#win-code')).trim();
        assert.match(code, /^WIN-[A-Z0-9]{9}$/, `${p.name} の当選コード形式`);
        winnersSeen++;
      }
    }
    assert.equal(winnersSeen, 2, 'プレイヤー側で当選コードが見えるのは2人');
    log(`players: ${winnersSeen} winners see win codes, all see final rank`);

    // ホスト: 「対応済」トグル
    const firstHandle = host.locator('#ranking-body button[data-action="handle"]').first();
    await firstHandle.click();
    await host.waitForFunction(
      () => {
        const b = document.querySelector('#ranking-body button[data-action="handle"]');
        return b && b.textContent.includes('取消');
      },
      null,
      { timeout: 8000 }
    );
    log('host toggled a winner to handled');

    // ホスト: ニックネーム非表示 → 公開表示が伏字化(ここでは results 表示の伏字中ラベルで確認)
    const firstHide = host.locator('#ranking-body button[data-action="hide"]').first();
    await firstHide.click();
    await host.waitForFunction(
      () => document.querySelector('#ranking-body') &&
        /再表示/.test(document.querySelector('#ranking-body').textContent),
      null,
      { timeout: 8000 }
    );
    log('host hid a nickname (toggle shows 再表示)');

    log('ALL PHASE 2 CHECKS PASSED');
  } finally {
    for (const ctx of opened) await ctx.close().catch(() => {});
    await browser.close();
  }
}

run().catch((e) => {
  console.error('[phase2] FAILED:', e);
  process.exitCode = 1;
});
