// QRBingo v2 (オンラインモード) — Firebase Web 設定
//
// この値は「公開されても問題ない」情報(Firebase の apiKey は秘密情報ではなく、
// アクセス制御は firestore.rules と App Check で行う設計 — 憲章/plan.md 参照)。
//
// 下記はローカル Emulator 専用のプレースホルダー(.firebaserc の "demo-qrbingo"
// と対応)。本番デプロイ時は Firebase コンソール →
// プロジェクトの設定 → マイアプリ → SDK 設定 から取得した値に置き換えること。
export const firebaseConfig = {
  apiKey: 'demo-emulator-key',
  authDomain: 'demo-qrbingo.firebaseapp.com',
  projectId: 'demo-qrbingo',
  storageBucket: 'demo-qrbingo.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:0000000000000000000000',
};
