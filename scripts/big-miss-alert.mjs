// 종가가 들어온 직후(prices.yml) 돌면서, 무매 계좌에서 큰수로 낮춰 건 탓에 못 산 매수가 있으면 폰으로 알립니다.
// 조건: 기록해 둔 주문(pending)의 장 종가가 큰수 가격보다 높고 원래 매수가 이하 (engine.js bigMisses, 앱 체결 확인 화면과 같음).
// 같은 장은 계좌마다 한 번만 보냅니다 (users/{uid}/settings/push.bigMissSent[계좌 id] = 장 날짜).
// 실행: FIREBASE_SERVICE_ACCOUNT='<서비스 계정 JSON>' node big-miss-alert.mjs
import { createRequire } from "node:module";
import { initDb, tokensByUser, sharedPrices, userAccounts, mergeBars, sendPush } from "./common.mjs";

const E = createRequire(import.meta.url)("../engine.js");
const n2 = (x) => Number(x).toFixed(2);
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

async function main() {
  const db = initDb();
  const byUser = await tokensByUser(db);
  if (!byUser.size) { console.log("알림을 켠 기기가 없습니다."); return; }
  const shared = await sharedPrices(db);

  for (const [uid, toks] of byUser) {
    const setRef = db.collection("users").doc(uid).collection("settings").doc("push");
    const sent = ((await setRef.get()).data() || {}).bigMissSent || {};
    const { accts, manual } = await userAccounts(db, uid);
    const lines = [], mark = {};
    for (const a of accts) {
      const p = a.pending;
      if (a.type === "VR" || !p || sent[a.id] === p.session) continue;
      const bar = mergeBars(shared[a.ticker], manual[a.ticker]).find((b) => b.d === p.session);
      if (!bar) continue;
      const miss = E.bigMisses(p.orders, bar);
      if (!miss.length) continue;
      const q = miss.reduce((s, o) => s + o.qty, 0);
      lines.push(`${a.name || a.ticker} ${md(p.session)} 종가 $${n2(bar.c)}: 큰수 $${n2(miss[0].price)}에 걸어 ${q}주 못 삼 (원래 ${miss.map((o) => `${o.label} $${n2(o.orig)}`).join(", ")})`);
      mark[a.id] = p.session;
    }
    console.log(`${uid.slice(0, 6)}…: ${lines.length ? lines.join(" / ") : "놓친 매수 없음"}`);
    if (!lines.length) continue;
    await setRef.set({ bigMissSent: { ...sent, ...mark } }, { merge: true });
    await sendPush(toks, { title: "큰수 때문에 못 산 매수가 있어요", body: lines.join(" · "), tag: "big-miss", ttlHours: 24 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
