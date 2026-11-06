// カメラで QR を読み取る共通ダイアログ。jsQR(lib/jsQR.js のグローバル)で解析する。
// openWinScanner() は読み取った文字列、閉じた場合は null を返す。
let dialog = null;

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'win-scan-dialog';
  dialog.innerHTML = `
    <h2 style="margin-top:0">当選コードのQRを読み取り</h2>
    <video class="scanner" playsinline muted></video>
    <p class="hint scan-status">カメラを起動しています…</p>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn-ghost scan-close" type="button">閉じる</button>
    </div>`;
  document.body.appendChild(dialog);
  return dialog;
}

export function openWinScanner() {
  const dlg = ensureDialog();
  const video = dlg.querySelector('video');
  const status = dlg.querySelector('.scan-status');
  let stream = null;
  let raf = 0;
  let done = false;

  return new Promise((resolve) => {
    const finish = (value) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      if (dlg.open) dlg.close();
      resolve(value);
    };
    dlg.querySelector('.scan-close').onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    status.textContent = 'カメラを起動しています…';
    dlg.showModal();

    if (typeof window.jsQR !== 'function' || !navigator.mediaDevices) {
      status.textContent = 'この端末ではカメラでの読み取りができません。';
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        if (done) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        await video.play();
        status.textContent = '当選者の画面のQRコードを枠内に写してください';
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const tick = () => {
          if (done) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = window.jsQR(img.data, img.width, img.height);
            if (code && code.data) {
              finish(code.data);
              return;
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      })
      .catch(() => {
        status.textContent = 'カメラを起動できませんでした。ブラウザのカメラの許可を確認してください。';
      });
  });
}
