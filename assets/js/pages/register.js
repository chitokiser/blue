// /assets/js/pages/register.js
// 회원가입: 기본 정보 저장 + 수탁 지갑 생성 + 온체인 등록

import { watchAuth, login } from "../auth.js";
import { auth, db, functions } from "/assets/js/firebase-init.js";

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

const $ = (id) => document.getElementById(id);

// ── 유틸 ──────────────────────────────────────────
function show(id, on) {
  const el = $(id);
  if (el) el.style.display = on ? "" : "none";
}

function setState(msg) {
  const el = $("regState");
  if (el) el.textContent = msg || "";
}

function setStep(id, status) {
  // status: "wait" | "doing" | "done" | "error"
  const el = $(id);
  if (!el) return;
  el.dataset.status = status;
}

function normalizePhone(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const plus = s.startsWith("+") ? "+" : "";
  const digits = s.replace(/[^0-9]/g, "");
  return plus ? plus + digits : digits;
}

function isValidPhone(p) {
  return String(p || "").replace(/[^0-9]/g, "").length >= 10;
}

// ── 이미 가입한 경우 표시 ──────────────────────────
function showAlreadyDone(userData, uid) {
  show("alreadyDone", true);
  show("regForm", false);

  // 전화번호 표시 + 수정 바인딩
  const phone = userData?.phone;
  show("phoneRow", true);
  const phoneEl = $("phoneDisplay");
  if (phoneEl) phoneEl.textContent = phone || "(미등록)";
  bindPhoneEdit(uid, phone || "");

  const wallet = userData?.wallet?.address;
  if (wallet) {
    show("walletRow", true);
    const el = $("walletAddr");
    if (el) el.textContent = wallet;
  }

  const registered = userData?.onChain?.registered;
  show("onChainRow", true);
  const statusEl = $("onChainStatus");
  if (statusEl) {
    statusEl.textContent = registered ? "등록 완료 ✓" : "미등록 (나중에 진행 가능)";
    statusEl.style.color = registered ? "var(--accent)" : "var(--muted)";
  }
}

function bindPhoneEdit(uid, currentPhone) {
  const btnEdit   = $("btnEditPhone");
  const input     = $("phoneEditInput");
  const btnSave   = $("btnSavePhone");
  const btnCancel = $("btnCancelPhone");
  const msg       = $("phoneSaveMsg");

  if (btnEdit) btnEdit.onclick = () => {
    if (input) input.value = currentPhone;
    show("phoneEditBox", true);
    show("btnEditPhone", false);
    if (input) input.focus();
  };

  if (btnCancel) btnCancel.onclick = () => {
    show("phoneEditBox", false);
    show("btnEditPhone", true);
    if (msg) msg.textContent = "";
  };

  if (btnSave) btnSave.onclick = async () => {
    const newPhone = normalizePhone(input?.value);
    if (!isValidPhone(newPhone)) {
      if (msg) { msg.textContent = "올바른 전화번호를 입력해 주세요 (10자리 이상)."; msg.style.color = "var(--danger, #e53e3e)"; }
      return;
    }
    btnSave.disabled = true;
    btnSave.textContent = "저장 중...";
    try {
      await setDoc(doc(db, "users", uid), { phone: newPhone, updatedAt: serverTimestamp() }, { merge: true });
      const phoneEl = $("phoneDisplay");
      if (phoneEl) phoneEl.textContent = newPhone;
      currentPhone = newPhone;
      if (msg) { msg.textContent = "저장되었습니다 ✓"; msg.style.color = "var(--accent)"; }
      setTimeout(() => {
        show("phoneEditBox", false);
        show("btnEditPhone", true);
        if (msg) msg.textContent = "";
      }, 1200);
    } catch (err) {
      if (msg) { msg.textContent = "저장 실패: " + err.message; msg.style.color = "var(--danger, #e53e3e)"; }
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = "저장";
    }
  };
}

// ── 가입 실행 ──────────────────────────────────────
async function doRegister(uid, email) {
  const name          = String($("userName")?.value    || "").trim();
  const phone         = normalizePhone($("userPhone")?.value);
  const mentorAddress = String($("mentorAddress")?.value || "").trim();
  const agreeTerms    = Boolean($("agreeTerms")?.checked);
  const agreeWallet   = Boolean($("agreeWallet")?.checked);

  // 유효성 검사
  if (!name)          throw new Error("이름을 입력해 주세요.");
  if (!phone)         throw new Error("휴대폰 번호를 입력해 주세요.");
  if (!isValidPhone(phone)) throw new Error("올바른 전화번호를 입력해 주세요. (10자리 이상)");
  if (!mentorAddress) throw new Error("멘토 지갑 주소를 입력해 주세요.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(mentorAddress))
    throw new Error("올바른 지갑 주소를 입력해 주세요. (0x로 시작하는 42자리 hex)");
  if (!agreeTerms)    throw new Error("이용약관에 동의해 주세요.");
  if (!agreeWallet)   throw new Error("수탁 지갑 생성에 동의해 주세요.");

  // 진행 표시
  show("stepBox", true);

  // ── 1단계: Firestore 저장 ──
  setStep("step1", "doing");
  // 토큰 강제 갱신 후 저장 (onAuthStateChanged 직후 토큰 전파 지연 방지)
  try {
    await auth.currentUser?.getIdToken(true);
  } catch (_) { /* 갱신 실패해도 계속 진행 */ }
  try {
    await setDoc(doc(db, "users", uid), {
      name,
      phone,
      email: email || "",
      mentorAddressInput: mentorAddress,
      agreeTerms:  true,
      agreeWallet: true,
      registeredAt: serverTimestamp(),
      updatedAt:    serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    throw new Error(`[1단계 저장 실패] ${e.message}`);
  }
  setStep("step1", "done");

  // ── 2단계: 수탁 지갑 생성 + 온체인 등록 (createWallet이 두 작업을 모두 처리) ──
  setStep("step2", "doing");
  setStep("step3", "doing");
  let walletAddress = null;
  const createWallet = httpsCallable(functions, "createWallet");
  try {
    const walletResult = await createWallet({ mentorAddress });
    walletAddress = walletResult.data?.address;
  } catch (e) {
    throw new Error(`[2단계 지갑생성 실패] ${e.message}`);
  }
  setStep("step2", "done");
  setStep("step3", "done");

  return walletAddress;
}

// ── 이벤트 바인딩 ──────────────────────────────────
function bindForm(uid, email) {
  const form = $("regForm");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("btnRegister");
    if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }

    try {
      setState("가입 처리 중...");
      const walletAddress = await doRegister(uid, email);
      setState("가입 완료!");

      // 완료 화면으로 전환
      show("regForm", false);
      show("alreadyDone", true);
      show("walletRow", true);
      const addrEl = $("walletAddr");
      if (addrEl) addrEl.textContent = walletAddress || "생성됨";
      show("onChainRow", true);
      const onChainEl = $("onChainStatus");
      if (onChainEl) {
        onChainEl.textContent = "등록 완료 ✓";
        onChainEl.style.color = "var(--accent)";
      }
    } catch (err) {
      console.error(err);
      setState("오류 발생");
      const box = $("stepBox");
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.style.color = "var(--danger, #e53e3e)";
      hint.textContent = err?.message || "오류가 발생했습니다. 다시 시도해 주세요.";
      if (box) box.after(hint);
      if (btn) { btn.disabled = false; btn.textContent = "가입 완료"; }
    }
  });
}

// ── 진입점 ────────────────────────────────────────
// onAuthReady(1회성)가 아닌 watchAuth(상시 구독)를 사용:
// 팝업 로그인 후 페이지 새로고침 없이도 인증 상태 변화를 감지해 폼을 표시합니다.
let _authDone = false;

async function _initForUser(user) {
  try {
    setState("내 정보 확인 중...");

    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? snap.data() : null;

    if (data?.name) {
      setState("이미 가입된 계정입니다.");
      showAlreadyDone(data, user.uid);
      return;
    }

    setState("");
    show("regForm", true);

    if (data?.phone) {
      const el = $("userPhone");
      if (el) el.value = data.phone;
    }

    // 멘토 주소 자동 설정: URL 파라미터 > 기본값
    const DEFAULT_MENTOR = "0xc662c3B58bE7345DE30dd8188B2Acc977943186A";
    const mentorEl = $("mentorAddress");
    if (mentorEl && !mentorEl.value) {
      const urlMentor = new URLSearchParams(location.search).get("mentor") || "";
      mentorEl.value = /^0x[0-9a-fA-F]{40}$/.test(urlMentor) ? urlMentor : DEFAULT_MENTOR;
    }

    bindForm(user.uid, user.email);
  } catch (err) {
    console.error(err);
    setState("오류");
    show("regForm", true);
    bindForm(user.uid, user.email);
  }
}

function _showNeedLogin() {
  setState("로그인이 필요합니다.");
  show("needLogin", true);
  const btnLogin = $("btnLoginPage");
  if (btnLogin) {
    btnLogin.onclick = async () => {
      try { await login(); } catch (e) { console.warn(e); }
      // watchAuth가 로그인 완료를 감지해서 자동으로 폼을 표시합니다.
    };
  }
}

// 로그인 상태 변화를 구독 — 팝업 로그인 후에도 즉시 반응
watchAuth(async (ctx) => {
  if (_authDone) return;
  if (!ctx.loggedIn || !ctx.user) return; // 아직 로그인 전 → 대기

  _authDone = true;
  show("needLogin", false); // 로그인 안내가 표시됐었다면 숨기기
  await _initForUser(ctx.user);
});

// 4초 이내에 로그인이 확인되지 않으면 미로그인 안내 표시
setTimeout(() => {
  if (!_authDone) {
    _showNeedLogin();
  }
}, 4000);
