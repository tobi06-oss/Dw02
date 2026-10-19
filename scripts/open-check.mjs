// 본장이 열리고 조금 뒤(뉴욕 9:32쯤~11:00) 돌면서, 오늘 장에 넣어 둔 무매 LOC 매수가가 본장 시가보다
// 거부 한도(계좌 rejectPct, 기본 20%) 넘게 높으면 폰으로 알립니다. 주간장에 넣은 LOC는 본장 시작 때 거래소로 넘어가며
// 그때 가격으로 다시 거부될 수 있습니다 (2026-10-19 메리츠: 현재가 101.2에서 122는 거부, 120은 접수).
// 같은 장은 계좌마다 한 번만 보냅니다 (users/{uid}/settings/push.openCheckSent[계좌 id] = 장 날짜).
// 실행: FIREBASE_SERVICE_ACCOUNT='<서비스 계정 JSON>' node open-check.mjs   (FORCE=1이면 시간 확인 생략)
import { createRequire } from "node:module";
import { initDb, tokensByUser, userAccounts, sendPush } from "./common.mjs";

const E = createRequire(import.meta.url)("../engine.js");
const FORCE = process.env.FORCE === "1";
const UA = { "User-Agent": "Mozilla/5.0 (desk-open-check)" };
const n2 = (x) => Number(x).toFixed(2);

const nyNow = () => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: (+g("hour") % 24) * 60 + +g("minute") };
};

// 오늘 본장 시가(첫 1분봉 시가)와 현재가
async function openPrice(t) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?range=1d&interval=1m&includePrePost=false`, { headers: UA });
  if (!r.ok) throw new Error(`yahoo ${t} HTTP ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  const ts = res?.timestamp || [], op = res?.indicators?.quote?.[0]?.open || [];
  const i = op.findIndex((v) => typeof v === "number" && isFinite(v));
  if (i < 0) throw new Error(`yahoo ${t} 오늘 봉 없음`);
  const d = new Date(ts[i] * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return { d, open: op[i], last: res.meta?.regularMarketPrice ?? null };
}

async function main() {
  const now = nyNow();
  // 서머타임·표준시 두 cron 중 본장 시작 1~90분 뒤에 걸리는 쪽만 실행 (예약 실행이 늦게 돌 수 있어 넉넉히. 두 번 걸려도 openCheckSent로 한 번만 보냄)
  if (!FORCE && (now.minutes < 9 * 60 + 31 || now.minutes > 11 * 60)) { console.log(`뉴욕 ${Math.floor(now.minutes / 60)}:${String(now.minutes % 60).padStart(2, "0")}, 확인 시간 아님`); return; }

  const db = initDb();
  const byUser = await tokensByUser(db);
  if (!byUser.size) { console.log("알림을 켠 기기가 없습니다."); return; }
  const quotes = {};
  const quote = async (t) => {
    if (!(t in quotes)) { try { quotes[t] = await openPrice(t); } catch (e) { console.warn(String(e)); quotes[t] = null; } }
    return quotes[t];
  };

  for (const [uid, toks] of byUser) {
    const setRef = db.collection("users").doc(uid).collection("settings").doc("push");
    const sent = ((await setRef.get()).data() || {}).openCheckSent || {};
    const { accts } = await userAccounts(db, uid);
    const lines = [], mark = {};
    for (const a of accts) {
      const p = a.pending;
      if (a.type === "VR" || !p || p.session !== now.date || sent[a.id] === p.session) continue;
      const q = await quote(a.ticker);
      if (!q || q.d !== now.date) continue;
      const risk = E.rejectRisk(p.orders, q.open, a);
      console.log(`${a.name || a.ticker}: 시가 ${n2(q.open)}, 위험 ${risk.length}건`);
      if (!risk.length) continue;
      const lim = a.rejectPct != null ? a.rejectPct : 20;
      lines.push(`${a.name || a.ticker} 시가 $${n2(q.open)}${q.last ? `(지금 $${n2(q.last)})` : ""}: ${risk.map((o) => `${o.label} $${n2(o.price)}`).join(", ")}가 시가 +${lim}% 넘어 거부됐을 수 있어요. 주문 상태를 확인하고 거부됐으면 $${n2(q.open * (1 + (lim - 1) / 100))} 이하로 다시 거세요`);
      mark[a.id] = p.session;
    }
    console.log(`${uid.slice(0, 6)}…: ${lines.length ? lines.join(" / ") : "거부 위험 없음"}`);
    if (!lines.length) continue;
    await setRef.set({ openCheckSent: { ...sent, ...mark } }, { merge: true });
    await sendPush(toks, { title: "LOC 매수가 거부됐을 수 있어요", body: lines.join(" · "), tag: "open-check", ttlHours: 6 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
