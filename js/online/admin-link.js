// 共通メニュー欄外の「運営メニュー」を運営者ログイン時だけ表示する。
// onUser は状態を見るだけで、未ログインの訪問者に匿名アカウントは作らない。
import { onUser } from './firebase-init.js';
import { isAdminUser } from './admin-config.js';

onUser((u) => {
  const el = document.getElementById('admin-link');
  if (el) el.hidden = !isAdminUser(u);
});
