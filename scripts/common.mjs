// 알림 스크립트들(order-reminder, big-miss-alert)이 같이 쓰는 함수
import admin from "firebase-admin";

const toArr = (b) => (Array.isArray(b) ? b : b.xh != null ? [b.d, b.o, b.h, b.l, b.c, b.xh, b.xl] : [b.d, b.o, b.h, b.l, b.c]);
// 앱의 mergeBars와 같음: 공용 종가 + 내가 직접 넣은 종가(우선)
export function mergeBars(g, m) {
  const map = new Map();
  (g?.bars || []).map(toArr).forEach((b) => map.set(b[0], b));
  (m?.bars || []).map(toArr).forEach((b) => map.set(b[0], b));
  return [...map.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-150)
    .map((b) => ({ d: b[0], o: b[1], h: b[2], l: b[3], c: b[4], xh: b.length > 5 ? b[5] : null, xl: b.length > 6 ? b[6] : null }));
}

export function initDb() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT 비밀값이 없습니다.");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return admin.firestore();
}

// 알림을 켠 기기: uid → [{ref, token}]
export async function tokensByUser(db) {
  const byUser = new Map();
  (await db.collectionGroup("pushTokens").get()).docs.forEach((d) => {
    const uid = d.ref.parent.parent.id, t = d.get("token");
    if (t) (byUser.get(uid) || byUser.set(uid, []).get(uid)).push({ ref: d.ref, token: t });
  });
  return byUser;
}

export async function sharedPrices(db) {
  const shared = {};
  (await db.collection("prices").get()).docs.forEach((d) => (shared[d.id] = d.data()));
  return shared;
}

// 사용자의 계좌(앱 탭 순서)와 직접 넣은 종가
export async function userAccounts(db, uid) {
  const manual = {};
  (await db.collection("users").doc(uid).collection("manualPrices").get()).docs.forEach((d) => (manual[d.id] = d.data()));
  const accts = (await db.collection("users").doc(uid).collection("accounts").get()).docs
    .map((d) => ({ ...d.data(), id: d.id }))
    .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0));
  return { accts, manual };
}

export async function sendPush(toks, { title, body, tag, ttlHours }) {
  const res = await admin.messaging().sendEachForMulticast({
    tokens: toks.map((t) => t.token),
    data: { title, body, tag },
    webpush: { headers: { Urgency: "high", TTL: String(ttlHours * 3600) } },
  });
  for (let i = 0; i < res.responses.length; i++) {
    const r = res.responses[i];
    if (r.success) continue;
    const code = r.error?.code || "";
    console.warn(`  보내기 실패: ${code} ${r.error?.message || ""}`);
    // 앱을 지웠거나 알림을 끈 기기는 목록에서 뺀다
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") await toks[i].ref.delete();
  }
  console.log(`  보냄 ${res.successCount}/${toks.length}`);
}
