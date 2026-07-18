// QRBingo v2 (オンラインモード) — Firebase Web 設定
//
// この値は「公開されても問題ない」情報(Firebase の apiKey は秘密情報ではなく、
// アクセス制御は firestore.rules と App Check で行う設計 — 憲章/plan.md 参照)。
//
// 本番プロジェクト: qrbingo-5c613
// ローカル開発では js/online/firebase-init.js が localhost を検知して
// 自動的に Emulator Suite に接続する(この本番設定値は使われない)。
export const firebaseConfig = {
  apiKey: 'AIzaSyBfwGmltadTQmfqfF91gFyTrswVT_LI9bk',
  authDomain: 'qrbingo-5c613.firebaseapp.com',
  projectId: 'qrbingo-5c613',
  storageBucket: 'qrbingo-5c613.firebasestorage.app',
  messagingSenderId: '183018538512',
  appId: '1:183018538512:web:18396cf483a8bb56fa2c95',
  measurementId: 'G-F4K2B9GWK5',
};
