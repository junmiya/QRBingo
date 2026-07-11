'use strict';

/* QRBingo ホスト画面 */

(() => {
  const CURRENT_KEY = 'qrbingo:host:current';
  const stateKey = (gameId) => 'qrbingo:host:' + gameId;

  const BALL_COLORS = ['var(--col-b)', 'var(--col-i)', 'var(--col-n)', 'var(--col-g)', 'var(--col-o)'];
  const ballColor = (n) => BALL_COLORS[Math.floor((n - 1) / 15)];

  const $ = (id) => document.getElementById(id);

  let gameId;
  let drawn; // 抽選済み番号の配列(抽選順)
  let rolling = false;

  // ---------- 状態 ----------
  function loadGame() {
    gameId = localStorage.getItem(CURRENT_KEY);
    if (gameId) {
      const state = QRB.loadJSON(stateKey(gameId), null);
      if (state && Array.isArray(state.drawn)) {
        drawn = state.drawn;
        return;
      }
    }
    newGame();
  }

  function newGame() {
    gameId = QRB.randomId(4);
    drawn = [];
    localStorage.setItem(CURRENT_KEY, gameId);
    saveGame();
  }

  function saveGame() {
    QRB.saveJSON(stateKey(gameId), { drawn, updatedAt: Date.now() });
  }

  // ---------- 参加用QR ----------
  function renderJoinInfo() {
    const url = new URL('player.html', location.href);
    url.searchParams.set('g', gameId);
    const joinUrl = url.toString();
    $('game-code').textContent = gameId;
    $('join-qr').innerHTML = QRB.qrSvg(joinUrl, 4);
    $('join-url').textContent = joinUrl;
  }

  // ---------- 抽選 ----------
  function remainingNumbers() {
    const used = new Set(drawn);
    const rest = [];
    for (let n = 1; n <= 75; n++) if (!used.has(n)) rest.push(n);
    return rest;
  }

  function renderBall(n) {
    const ball = $('current-ball');
    if (n == null) {
      ball.className = 'ball empty';
      ball.innerHTML = '<span class="ball-number">?</span>';
      return;
    }
    ball.className = 'ball';
    ball.style.setProperty('--ball-color', ballColor(n));
    ball.innerHTML =
      '<span class="ball-letter">' + QRB.columnLetter(n) + '</span>' +
      '<span class="ball-number">' + n + '</span>';
  }

  function renderHistory() {
    const box = $('history');
    box.innerHTML = '';
    drawn.forEach((n, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (i === drawn.length - 1 ? ' latest' : '');
      chip.style.setProperty('--ball-color', ballColor(n));
      chip.textContent = n;
      box.appendChild(chip);
    });
    $('count-note').textContent = drawn.length
      ? `抽選済み: ${drawn.length} / 75`
      : 'まだ抽選されていません';
    $('draw-btn').disabled = rolling || drawn.length >= 75;
    if (drawn.length >= 75) $('draw-btn').textContent = '全番号を抽選しました';
  }

  function draw() {
    const rest = remainingNumbers();
    if (rolling || rest.length === 0) return;
    rolling = true;
    $('draw-btn').disabled = true;

    const result = rest[Math.floor(Math.random() * rest.length)];
    const ball = $('current-ball');
    ball.classList.add('rolling');

    // ルーレット演出:ランダム表示を回してから確定
    let ticks = 0;
    const timer = setInterval(() => {
      renderBall(rest[Math.floor(Math.random() * rest.length)]);
      ball.classList.add('rolling');
      if (++ticks >= 14) {
        clearInterval(timer);
        drawn.push(result);
        saveGame();
        renderBall(result);
        ball.classList.remove('rolling');
        ball.classList.add('pop');
        setTimeout(() => ball.classList.remove('pop'), 500);
        rolling = false;
        renderHistory();
      }
    }, 90);
  }

  // ---------- 検証 ----------
  function renderVerifyCard(cardId, grid, evalResult, drawnSet) {
    let html = '<table class="bingo readonly"><thead><tr>';
    QRB.COLUMNS.forEach((c, i) => { html += `<th class="col-${i}">${c}</th>`; });
    html += '</tr></thead><tbody>';

    const bingoCells = new Set();
    evalResult.bingoLines.forEach((line) =>
      line.forEach((c) => bingoCells.add(c.col + ':' + c.row)));

    for (let row = 0; row < 5; row++) {
      html += '<tr>';
      for (let col = 0; col < 5; col++) {
        const n = grid[col][row];
        const free = n === QRB.FREE;
        const marked = free || drawnSet.has(n);
        const cls = [
          marked ? 'marked' : '',
          free ? 'free' : '',
          bingoCells.has(col + ':' + row) ? 'bingo-cell' : '',
        ].filter(Boolean).join(' ');
        html += `<td class="${cls}">${free ? 'FREE' : n}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  function verify(rawInput) {
    const box = $('verify-result');
    const cardId = String(rawInput || '').trim().toUpperCase();
    if (!cardId) return;

    if (!cardId.startsWith(gameId + '-')) {
      box.innerHTML = `<div class="status-banner ng">このカードは現在のゲーム(${gameId})のものではありません</div>`;
      return;
    }

    const grid = QRB.generateCard(cardId);
    const drawnSet = new Set(drawn);
    const result = QRB.evaluateCard(grid, drawnSet);

    let banner;
    if (result.bingoLines.length > 0) {
      banner = `<div class="status-banner ok">🎉 ビンゴ成立!(${result.bingoLines.length}ライン)</div>`;
    } else if (result.reachCount > 0) {
      banner = `<div class="status-banner ng">まだビンゴではありません(リーチ ${result.reachCount}本)</div>`;
    } else {
      banner = '<div class="status-banner ng">まだビンゴではありません</div>';
    }

    box.innerHTML =
      banner +
      `<p class="card-id-label">カードID: ${cardId}</p>` +
      '<div class="card-wrap">' + renderVerifyCard(cardId, grid, result, drawnSet) + '</div>';
  }

  // ---------- QRスキャン ----------
  let scanStream = null;
  let scanRaf = 0;

  async function openScanner() {
    const dialog = $('scan-dialog');
    const video = $('scan-video');
    const status = $('scan-status');
    dialog.showModal();
    status.textContent = 'カメラを起動しています…';

    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
    } catch (e) {
      status.textContent = 'カメラを起動できませんでした。カードIDを手入力してください。';
      return;
    }

    video.srcObject = scanStream;
    await video.play();
    status.textContent = 'カードのQRコードを枠内に写してください';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      if (!scanStream) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height);
        if (code && code.data) {
          $('verify-input').value = code.data.trim().toUpperCase();
          closeScanner();
          verify(code.data);
          return;
        }
      }
      scanRaf = requestAnimationFrame(tick);
    };
    scanRaf = requestAnimationFrame(tick);
  }

  function closeScanner() {
    cancelAnimationFrame(scanRaf);
    if (scanStream) {
      scanStream.getTracks().forEach((t) => t.stop());
      scanStream = null;
    }
    $('scan-video').srcObject = null;
    $('scan-dialog').close();
  }

  // ---------- イベント ----------
  $('draw-btn').addEventListener('click', draw);

  $('verify-btn').addEventListener('click', () => verify($('verify-input').value));
  $('verify-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verify($('verify-input').value);
  });

  $('scan-btn').addEventListener('click', openScanner);
  $('scan-close').addEventListener('click', closeScanner);
  $('scan-dialog').addEventListener('close', () => {
    if (scanStream) closeScanner();
  });

  $('reset-btn').addEventListener('click', () => {
    if (!confirm('新しいゲームを開始しますか?\n現在のゲームコードと抽選履歴はリセットされます。')) return;
    newGame();
    renderJoinInfo();
    renderBall(null);
    renderHistory();
    $('verify-result').innerHTML = '';
    $('verify-input').value = '';
  });

  // ---------- 初期化 ----------
  loadGame();
  renderJoinInfo();
  renderBall(drawn.length ? drawn[drawn.length - 1] : null);
  renderHistory();
})();
