'use strict';

/* QRBingo プレイヤー画面 */

(() => {
  const $ = (id) => document.getElementById(id);
  const stateKey = (gameId) => 'qrbingo:player:' + gameId;

  let gameId = null;
  let cardId = null;
  let grid = null;
  let marks = new Set(); // タップ済みの番号

  // ---------- 状態 ----------
  function loadOrCreateCard() {
    const saved = QRB.loadJSON(stateKey(gameId), null);
    if (saved && saved.cardId) {
      cardId = saved.cardId;
      marks = new Set(saved.marks || []);
    } else {
      cardId = gameId + '-' + QRB.randomId(6);
      marks = new Set();
      saveState();
    }
    grid = QRB.generateCard(cardId);
  }

  function saveState() {
    QRB.saveJSON(stateKey(gameId), { cardId, marks: [...marks], updatedAt: Date.now() });
  }

  // ---------- 描画 ----------
  function renderCard() {
    const evalResult = QRB.evaluateCard(grid, marks);
    const bingoCells = new Set();
    evalResult.bingoLines.forEach((line) =>
      line.forEach((c) => bingoCells.add(c.col + ':' + c.row)));

    const table = $('card');
    table.innerHTML = '';

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    QRB.COLUMNS.forEach((c, i) => {
      const th = document.createElement('th');
      th.className = 'col-' + i;
      th.textContent = c;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let row = 0; row < 5; row++) {
      const tr = document.createElement('tr');
      for (let col = 0; col < 5; col++) {
        const n = grid[col][row];
        const free = n === QRB.FREE;
        const td = document.createElement('td');
        td.textContent = free ? 'FREE' : n;
        if (free) td.classList.add('free', 'marked');
        else if (marks.has(n)) td.classList.add('marked');
        if (bingoCells.has(col + ':' + row)) td.classList.add('bingo-cell');
        if (!free) {
          td.addEventListener('click', () => {
            if (marks.has(n)) marks.delete(n);
            else marks.add(n);
            saveState();
            renderCard();
          });
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    renderStatus(evalResult);
  }

  function renderStatus(evalResult) {
    const banner = $('status-banner');
    if (evalResult.bingoLines.length > 0) {
      banner.className = 'status-banner bingo';
      banner.textContent = '🎉 ビンゴ!QRをホストに見せよう!';
    } else if (evalResult.reachCount > 0) {
      banner.className = 'status-banner reach';
      banner.textContent = `🔥 リーチ!(${evalResult.reachCount}本)`;
    } else {
      banner.className = 'status-banner';
      banner.textContent = '番号が呼ばれたらタップしてマーク!';
    }
  }

  function showGame() {
    $('join-form').hidden = true;
    $('game-area').hidden = false;
    $('game-label').textContent = gameId;
    $('card-id-label').textContent = 'カードID: ' + cardId;
    renderCard();
  }

  function showJoinForm(message) {
    $('game-area').hidden = true;
    $('join-form').hidden = false;
    $('join-error').textContent = message || '';
    $('game-input').focus();
  }

  // ---------- 参加 ----------
  function joinGame(code) {
    const normalized = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(normalized)) {
      showJoinForm('ゲームコードは4〜8文字の英数字です。');
      return;
    }
    gameId = normalized;
    localStorage.setItem('qrbingo:player:last', gameId);
    loadOrCreateCard();
    showGame();
  }

  // ---------- イベント ----------
  $('join-btn').addEventListener('click', () => joinGame($('game-input').value));
  $('game-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinGame($('game-input').value);
  });

  $('show-qr-btn').addEventListener('click', () => {
    $('card-qr').innerHTML = QRB.qrSvg(cardId, 5);
    $('dialog-card-id').textContent = cardId;
    $('qr-dialog').showModal();
  });
  $('qr-close').addEventListener('click', () => $('qr-dialog').close());

  $('new-card-btn').addEventListener('click', () => {
    if (!confirm('カードを引き直しますか?\n現在のカードとマークは失われます。')) return;
    cardId = gameId + '-' + QRB.randomId(6);
    marks = new Set();
    saveState();
    grid = QRB.generateCard(cardId);
    $('card-id-label').textContent = 'カードID: ' + cardId;
    renderCard();
  });

  $('leave-btn').addEventListener('click', () => {
    const url = new URL(location.href);
    url.searchParams.delete('g');
    gameId = null;
    history.replaceState(null, '', url.toString());
    $('game-input').value = '';
    showJoinForm('');
  });

  // ---------- 初期化 ----------
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('g');
  const last = localStorage.getItem('qrbingo:player:last');

  if (fromUrl) {
    joinGame(fromUrl);
  } else if (last && QRB.loadJSON(stateKey(last), null)) {
    joinGame(last);
  } else {
    showJoinForm('');
  }
})();
