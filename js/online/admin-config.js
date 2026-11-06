// 運営者の判定(画面表示の切替用)。権限そのものはサーバー(adminOps)が
// 検証済みメール(email_verified)で強制するので、ここを書き換えても操作はできない。
export const ADMIN_EMAILS = ['miyajun@gmail.com'];

export function isAdminUser(u) {
  const email = u && !u.isAnonymous && u.email ? String(u.email).toLowerCase() : '';
  return ADMIN_EMAILS.includes(email);
}
