// 평일 낮 12시~밤 11시 반 사이 30분마다 돌면서, 각자 고른 알림 시간(users/{uid}/settings/push.time, 기본 21:00)이
// 지났고 오늘 아직 안 보냈으면, 오늘 밤 주문을 안 넣은 계좌가 있을 때 폰으로 푸시 알림을 보냅니다.
// "주문 전" 판정은 앱 탭 배지와 같은 engine.js orderStatus를 씁니다.
// 알림 받을 기기는 앱의 "주문 알림" 패널에서 켜면 users/{uid}/pushTokens/{id}에 저장됩니다.
// 실행: FIREBASE_SERVICE_ACCOUNT='<서비스 계정 JSON>' node order-reminder.mjs   (TEST=1이면 주문 여부와 상관없이 테스트 알림)
import { createRequire } from "node:module";
import { initDb, tokensByUser, sharedPrices, userAccounts, mergeBars, sendPush } from "./common.mjs";

const E = createRequire(import.meta.url)("../engine.js");
const TEST = process.env.TEST === "1";

// 한국 시각의 오늘 날짜(= 오늘 밤 열리는 미국장 날짜)와 HH:MM
const kstNow = () => { const iso = new Date(Date.now() + 9 * 3600e3).toISOString(); return { date: iso.slice(0, 10), hm: iso.slice(11, 16) }; };
const DEFAULT_TIME = "21:00";

async function main() {
  const db = initDb();

  const { date: session, hm } = kstNow();
  // 주말·미국 휴장일은 engine.js 달력(CAL)으로 거릅니다. 해마다 engine.js에 다음 해를 추가하세요.
  if (!TEST && !E.isSession(session)) { console.log(`${session}: 미국장 휴장, 알림 없음`); return; }

  const byUser = await tokensByUser(db);
  if (!byUser.size) { console.log("알림을 켠 기기가 없습니다. 앱에서 '주문 알림'을 켜세요."); return; }

  const shared = await sharedPrices(db);

  for (const [uid, toks] of byUser) {
    const setRef = db.collection("users").doc(uid).collection("settings").doc("push");
    const set = (await setRef.get()).data() || {};
    const at = /^\d\d:\d\d$/.test(set.time || "") ? set.time : DEFAULT_TIME;
    // 공개 저장소라 실행 기록은 누구나 본다: 사용자·계좌 내용은 찍지 않고 개수만 남긴다
    if (!TEST && (hm < at || set.lastSent === session)) { console.log(`사용자 1명: ${set.lastSent === session ? "오늘 이미 보냄" : "아직 시간 전"}`); continue; }
    const { accts, manual } = await userAccounts(db, uid);
    const todo = [];
    for (const a of accts) {
      const st = E.orderStatus(a, mergeBars(shared[a.ticker], manual[a.ticker]));
      if (st) todo.push(`${a.name || a.ticker} ${st.txt}`);
    }
    console.log(`사용자 1명: 주문 전 계좌 ${todo.length}개 (기기 ${toks.length}대)`);
    if (!TEST) await setRef.set({ lastSent: session }, { merge: true }); // 하루 한 번만 확인 (그 뒤에 넣은 주문은 다시 안 알림)
    if (!todo.length && !TEST) continue;

    const title = TEST ? "테스트 알림" : "아직 주문 안 넣은 계좌가 있어요";
    const body = TEST ? `알림이 잘 옵니다. 지금 상태: ${todo.join(", ") || "모두 주문함"}` : todo.join(" · ");
    // 장 마감(한국시간 새벽 5~6시)이 지나면 의미가 없으니 8시간 안에 못 받으면 버립니다.
    await sendPush(toks, { title, body, tag: "order-reminder", ttlHours: 8 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
