// QRBingo v2 (オンラインモード) — Firebase SDK 初期化
//
// SDK は lib/firebase/ にベンダリング済み(実行時 CDN 依存を作らない、憲章の制約)。
// localhost で動作している場合は自動的に Emulator Suite に接続する。

import { initializeApp } from '../../lib/firebase/firebase-app.js';
import {
  getAuth,
  connectAuthEmulator,
  signInAnonymously,
  onAuthStateChanged,
  GoogleAuthProvider,
  linkWithPopup,
  signInWithPopup,
  signOut,
} from '../../lib/firebase/firebase-auth.js';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  collection,
  onSnapshot,
  getDoc,
  query,
  orderBy,
  limit,
} from '../../lib/firebase/firebase-firestore.js';
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from '../../lib/firebase/firebase-functions.js';
import { firebaseConfig } from './firebase-config.js';

const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

// firebase-config.js が本番プロジェクト値に差し替え済みか判定する。
// 既定は Emulator 専用のプレースホルダー(projectId が "demo-" 始まり)。
// localhost では Emulator に接続するため常に利用可能。それ以外の環境
// (公開ホスティング)では本番設定が入っている場合のみオンライン機能を有効化する。
const IS_CONFIGURED =
  !!firebaseConfig.projectId && !String(firebaseConfig.projectId).startsWith('demo-');
const ONLINE_AVAILABLE = IS_LOCAL || IS_CONFIGURED;

// localhost では常に Emulator 用の demo プロジェクト設定で初期化する。
// firebase-config.js が本番値でも、Emulator は demo-qrbingo で起動しているため
// projectId を合わせないと Functions の呼び出し先 URL が一致しない。
const DEMO_CONFIG = {
  apiKey: 'demo-emulator-key',
  authDomain: 'demo-qrbingo.firebaseapp.com',
  projectId: 'demo-qrbingo',
  appId: '1:0:web:demo',
};

const app = initializeApp(IS_LOCAL ? DEMO_CONFIG : firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

if (IS_LOCAL) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}

// 匿名認証でサインイン済みであることを保証する(1 UID = 1 カードの基盤)。
// 既にセッションが残っていれば同じ UID を再利用する(FR-013 セッション継続)。
let signInPromise = null;
function ensureSignedIn() {
  if (!signInPromise) {
    signInPromise = new Promise((resolve, reject) => {
      const unsubscribe = onAuthStateChanged(
        auth,
        (user) => {
          unsubscribe();
          if (user) {
            resolve(user);
          } else {
            signInAnonymously(auth).then((cred) => resolve(cred.user)).catch(reject);
          }
        },
        reject
      );
    });
  }
  return signInPromise;
}

// 認証状態の変化を購読する(匿名⇄Google の切替を検知)。
function onUser(cb) {
  return onAuthStateChanged(auth, (u) => cb(u));
}

// 匿名アカウントを Google に昇格(リンク)する。UID は維持され、既存の
// entitlement 等が引き継がれる。そのGoogleが既に別UIDに存在する場合は
// そちらでサインインする(その場合UIDは変わる)。
async function linkGoogle() {
  const provider = new GoogleAuthProvider();
  const user = auth.currentUser;
  try {
    if (user && user.isAnonymous) {
      const cred = await linkWithPopup(user, provider);
      return cred.user;
    }
    const cred = await signInWithPopup(auth, provider);
    return cred.user;
  } catch (err) {
    if (err && err.code === 'auth/credential-already-in-use') {
      const cred = await signInWithPopup(auth, provider);
      return cred.user;
    }
    throw err;
  }
}

async function signOutHost() {
  await signOut(auth);
}

function callable(name) {
  const fn = httpsCallable(functions, name);
  return async (data) => {
    const res = await fn(data);
    return res.data;
  };
}

function watchGame(gameId, onChange) {
  return onSnapshot(doc(db, 'games', gameId), (snap) => {
    onChange(snap.exists() ? snap.data() : null);
  });
}

// ゲームを一度だけ読む(再接続時のホスト確認などに使う)。存在しなければ null。
async function readGame(gameId) {
  const snap = await getDoc(doc(db, 'games', gameId));
  return snap.exists() ? snap.data() : null;
}

// 任意のドキュメントパスを購読する汎用ヘルパー。
// segments 例: ['games', gameId, 'public', 'leaderboard'] / ['winners', winnerId]
function watchDocPath(segments, onChange) {
  return onSnapshot(doc(db, ...segments), (snap) => {
    onChange(snap.exists() ? snap.data() : null);
  });
}

// コレクション全体を購読する汎用ヘルパー(並び替えは呼び出し側で行う)。
// segments 例: ['games', gameId, 'reaches']
function watchCollectionPath(segments, onChange, onError) {
  return onSnapshot(
    collection(db, ...segments),
    (snap) => {
      onChange(snap.docs.map((d) => d.data()));
    },
    onError || (() => {})
  );
}

// 並び替え・件数制限つきのコレクション購読。docs は id 付きで返す。
// 例: watchOrdered(['games', gid, 'chat'], 'createdAt', 'asc', 100, onDocs)
function watchOrdered(segments, field, direction, limitN, onChange, onError) {
  const q = query(collection(db, ...segments), orderBy(field, direction), limit(limitN));
  return onSnapshot(
    q,
    (snap) => {
      onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    onError || (() => {})
  );
}

export {
  app,
  auth,
  db,
  functions,
  ONLINE_AVAILABLE,
  ensureSignedIn,
  onUser,
  linkGoogle,
  signOutHost,
  callable,
  watchGame,
  readGame,
  watchDocPath,
  watchCollectionPath,
  watchOrdered,
};
