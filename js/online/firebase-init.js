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
} from '../../lib/firebase/firebase-auth.js';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  onSnapshot,
} from '../../lib/firebase/firebase-firestore.js';
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from '../../lib/firebase/firebase-functions.js';
import { firebaseConfig } from './firebase-config.js';

const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

const app = initializeApp(firebaseConfig);
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

export { app, auth, db, functions, ensureSignedIn, callable, watchGame };
