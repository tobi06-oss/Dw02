// Firebase 콘솔 > 프로젝트 설정 > 내 앱 > SDK 설정의 값입니다.
// 이 값은 비밀키가 아니라 브라우저에 공개되는 설정이라 GitHub에 올려도 됩니다.
// 실제 접근은 firestore.rules(보안 규칙)로 막습니다.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDURhGmbTl46npKC2GWMkWuWMBZJEAiwKw",
  authDomain: "dw02-8988c.firebaseapp.com",
  projectId: "dw02-8988c",
  storageBucket: "dw02-8988c.firebasestorage.app",
  messagingSenderId: "633281738874",
  appId: "1:633281738874:web:d17c7560fb5cbe34f7a3c3"
};

// 밤 9시 주문 알림용 웹 푸시 공개키(VAPID). 공개되는 값이라 GitHub에 올려도 됩니다.
// Firebase 콘솔 > 프로젝트 설정 > 클라우드 메시징 > 웹 푸시 인증서 > "키 쌍 생성" 후 나오는 긴 문자열을 넣으세요.
export const VAPID_KEY = "";
