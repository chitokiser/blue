// /assets/js/pages/mypage.js
// MyPage: profile / wallet / on-chain status / deposit & payment history

import { onAuthReady } from "../auth.js";
import { db, functions } from "/assets/js/firebase-init.js";
import { login } from "../auth.js";

import {
  doc,
  getDoc,
  setDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { initSlot } from "/assets/js/jackpot-anim.js";

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

const $ = (id) => document.getElementById(id);

function show(id, on) {
  const el = $(id);
  if (el) el.style.display = on ? "" : "none";
}

function setText(id, val) {
  const el = $(id);
  if (el) el.textContent = val != null ? String(val) : "-";
}

function renderProfile(userData, fireUser) {
  setText("infoName", userData?.name || "-");
  setText("infoEmail", fireUser?.email || userData?.email || "-");
  setText("infoPhone", userData?.phone || "-");
}

function renderWallet(userData) {
  const addr = userData?.wallet?.address;
  const isMetaMask = userData?.wallet?.type === "metamask" || (addr && !userData?.wallet?.encryptedKey);

  if (!addr) {
    show("noWallet", true);
    show("walletInfo", false);
    show("btnCreateWallet", true);
    show("btnConnectMetaMask", false);
    setText("onChainStatus", "-");
    return;
  }

  show("noWallet", false);
  show("walletInfo", true);
  show("btnConnectMetaMask", false);
  show("metamaskWarning", isMetaMask);
  show("btnCreateWallet", isMetaMask);
  if (!isMetaMask) show("btnCreateWallet", false);
  setText("walletAddress", addr);
}

async function loadOnChainData(uid) {
  const addr = (await getDoc(doc(db, "users", uid))).data()?.wallet?.address;
  if (!addr) return;

  setText("onChainStatus", "\uC870\uD68C \uC911...");

  try {
    const getMyOnChain = httpsCallable(functions, "getMyOnChain");
    const res = await getMyOnChain();
    const d = res.data;

    if (d.level > 0) {
      setText("onChainStatus", "\uB4F1\uB85D \uC644\uB8CC \u2713");
      $("onChainStatus").style.color = "var(--accent)";

      show("levelRow", true);
      show("pointRow", true);

      const fmtBalance = (krw, usd, vnd, hex) => {
        if (krw == null) return (hex || "0") + " HEX";
        const parts = [Number(krw).toLocaleString() + "\uC6D0"];
        if (usd != null) parts.push("$" + Number(usd).toFixed(2));
        if (vnd != null) parts.push(Number(vnd).toLocaleString() + " VND");
        return parts.join(" / ");
      };

      setText("levelDisplay", "Lv." + d.level);
      setText("pointDisplay", fmtBalance(d.pointKrw, d.pointUsd, d.pointVnd, d.pointDisplay));

      show("expRow", true);
      show("expBarRow", true);

      const expPct = d.requiredExp > 0
        ? Math.min(100, Math.round((d.exp / d.requiredExp) * 100))
        : 0;

      setText("expDisplay", `${d.exp.toLocaleString()} / ${d.requiredExp.toLocaleString()}`);

      const barFill = $("expBarFill");
      if (barFill) barFill.style.width = expPct + "%";

      const expReqEl = $("expRequired");
      if (expReqEl) {
        const remain = Math.max(0, d.requiredExp - d.exp);
        expReqEl.textContent = remain > 0
          ? `\uB2E4\uC74C \uB808\uBCA8\uAE4C\uC9C0 ${remain.toLocaleString()} EXP \uD544\uC694`
          : "\uB808\uBCA8\uC5C5 \uAC00\uB2A5";
      }

      show("levelUpRow", d.exp >= d.requiredExp);

      const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
      const isZeroMentor = !d.mentor || d.mentor === ZERO_ADDR;
      show("mentorAddrRow", true);

      let mentorText = "\uBBF8\uC5F0\uACB0 (\uAE30\uBCF8 \uBA58\uD1A0)";
      if (!isZeroMentor) {
        try {
          const mentorSnap = await getDocs(
            query(collection(db, "mentors"), where("address", "==", d.mentor), limit(1))
          );
          mentorText = !mentorSnap.empty
            ? (mentorSnap.docs[0].data()?.email || d.mentor)
            : d.mentor.slice(0, 6) + "..." + d.mentor.slice(-4);
        } catch {
          mentorText = d.mentor.slice(0, 6) + "..." + d.mentor.slice(-4);
        }
      }

      const mentorEl = $("mentorAddrDisplay");
      if (mentorEl) {
        mentorEl.textContent = mentorText;
        const isEmail = mentorText.includes("@");
        mentorEl.classList.toggle("mono", !isEmail);
        mentorEl.style.fontSize = isEmail ? "0.95em" : "0.78em";
      }

      show("mentorNotice", isZeroMentor);
      show("mentorRequestBox", isZeroMentor);

      const walletHexBig = BigInt(d.walletHexWei || "0");
      show("walletHexRow", walletHexBig > 0n);
      if (walletHexBig > 0n) {
        setText("walletHexDisplay", fmtBalance(d.walletHexKrw, d.walletHexUsd, d.walletHexVnd, d.walletHexDisplay));
      }

      show("onChainRegBox", false);
    } else {
      setText("onChainStatus", "\uBBF8\uB4F1\uB85D");
      $("onChainStatus").style.color = "var(--muted)";
      show("onChainRegBox", true);
    }
  } catch (err) {
    console.warn("getMyOnChain failed:", err.message);
    try {
      const cached = (await getDoc(doc(db, "users", uid))).data()?.onChain;
      if (cached?.registered) {
        setText("onChainStatus", "\uB4F1\uB85D \uC644\uB8CC \u2713");
        $("onChainStatus").style.color = "var(--accent)";
        show("onChainRegBox", false);
      } else {
        setText("onChainStatus", "\uBBF8\uB4F1\uB85D");
        $("onChainStatus").style.color = "var(--muted)";
        show("onChainRegBox", true);
      }
    } catch {
      setText("onChainStatus", "\uC870\uD68C \uC2E4\uD328");
      $("onChainStatus").style.color = "var(--muted)";
    }
  }
}

async function loadDepositHistory(uid) {
  const wrap = $("depositHistory");
  if (!wrap) return;

  try {
    const q = query(
      collection(db, "deposits"),
      where("uid", "==", uid),
      orderBy("requestedAt", "desc"),
      limit(50)
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      wrap.innerHTML = '<p class="hint">\uCDA9\uC804 \uB0B4\uC5ED\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.</p>';
      return;
    }

    const statusLabel = {
      pending: "\uB300\uAE30",
      processing: "\uCC98\uB9AC\uC911",
      approved: "\uC644\uB8CC",
      rejected: "\uBC18\uB824",
    };

    const rows = snap.docs.map((d) => {
      const data = d.data();
      const dateStr = data.requestedAt?.toDate
        ? data.requestedAt.toDate().toLocaleDateString("ko")
        : "-";

      const amountParts = [(data.amountKrw || 0).toLocaleString() + "\uC6D0"];
      if (data.usdAmount != null) amountParts.push("$" + Number(data.usdAmount).toFixed(2));
      if (data.vndAmount != null) amountParts.push(Number(data.vndAmount).toLocaleString() + " VND");
      const amountStr = amountParts.join(" / ");

      return `
        <div class="mp-hist-row">
          <div class="mp-hist-main">
            <span class="mp-hist-code">${data.refCode || "-"}</span>
            <span class="mp-hist-badge ${data.status}">${statusLabel[data.status] || data.status}</span>
          </div>
          <div class="mp-hist-detail">
            <span class="accent">${amountStr}</span>
            <span class="muted">${dateStr}</span>
          </div>
          ${data.txHash ? `<div class="mp-hist-tx mono">${data.txHash.slice(0, 16)}...</div>` : ""}
        </div>
      `;
    }).join("");

    wrap.innerHTML = rows;
  } catch (err) {
    wrap.innerHTML = '<p class="hint muted">\uCDA9\uC804 \uB0B4\uC5ED \uC870\uD68C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.</p>';
    console.warn("depositHistory failed", err.message);
  }
}

async function loadMentees() {
  const section = $("menteeSection");
  const wrap = $("menteeList");
  if (!section || !wrap) return;

  try {
    const fn = httpsCallable(functions, "getMyMentees");
    const res = await fn();
    const { mentees } = res.data;

    show("menteeSection", true);

    if (!mentees || mentees.length === 0) {
      wrap.innerHTML = '<p class="hint">\uB4F1\uB85D\uB41C \uBA58\uD2F0\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.</p>';
      return;
    }

    const rows = mentees.map((m) => {
      const addrShort = m.address ? m.address.slice(0, 6) + "..." + m.address.slice(-4) : "-";
      const dateStr = m.registeredAt ? new Date(m.registeredAt).toLocaleDateString("ko") : "-";
      return `
        <div class="mp-hist-row">
          <div class="mp-hist-main">
            <span style="font-weight:600;">${m.name}</span>
            <span class="mono muted" style="font-size:0.82em;">${addrShort}</span>
          </div>
          <div class="mp-hist-detail">
            <span class="muted" style="font-size:0.85em;">\uAC00\uC785\uC77C: ${dateStr}</span>
          </div>
        </div>
      `;
    }).join("");

    wrap.innerHTML = `<p class="hint muted" style="margin-bottom:8px;">\uCD1D ${mentees.length}\uBA85</p>` + rows;
  } catch (err) {
    show("menteeSection", true);
    wrap.innerHTML = '<p class="hint muted">\uBA58\uD2F0 \uBAA9\uB85D \uC870\uD68C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.</p>';
    console.warn("getMyMentees failed", err.message);
  }
}

const TX_CONFIG = {
  buy:             { label: "충전",          dir: "income",  icon: "💰" },
  credit:          { label: "포인트 지급",   dir: "income",  icon: "⭐" },
  p2p:             { label: "P2P 수령",      dir: "income",  icon: "📥" },
  p2p_merge:       { label: "P2P 합산",      dir: "income",  icon: "📥" },
  withdraw:        { label: "인출",          dir: "expense", icon: "📤" },
  pay_merchant:    { label: "가맹점 결제",   dir: "expense", icon: "🛒" },
  merchant_income: { label: "가맹점 수익",   dir: "income",  icon: "🏪" },
  jackpot_paid:    { label: "🎰 잭팟 당첨금", dir: "income",  icon: "🏆" },
  jackpot_requested: { label: "잭팟 인출 신청", dir: "pending",  icon: "⏳" },
  jackpot_rejected:  { label: "잭팟 인출 거절", dir: "rejected", icon: "✕" },
};

function txAmountHex(tx) {
  if (tx.amountHex)    return Number(tx.amountHex);
  // merchant_income 은 순수익(netAmountWei) 우선 표시
  if (tx.netAmountWei) return Number(formatWei(tx.netAmountWei));
  if (tx.amountWei)    return Number(formatWei(tx.amountWei));
  if (tx.priceWei)     return Number(formatWei(tx.priceWei));
  return 0;
}

function renderTxItem({ label, icon, dir, amountHex, dateStr, txHash, statusBadge }) {
  const amtSign = dir === "income" ? "+" : dir === "expense" ? "−" : "";
  const amtClass = dir === "income" ? "income" : dir === "expense" ? "expense" : dir;
  const amtText = amountHex > 0
    ? `${amtSign}${amountHex.toLocaleString("ko-KR", { maximumFractionDigits: 4 })} HEX`
    : "-";
  const hashHtml = txHash
    ? `<div class="tx-hash">${txHash.slice(0, 10)}...${txHash.slice(-6)}</div>`
    : "";
  const badgeHtml = statusBadge
    ? `<span class="tx-status-badge ${statusBadge.cls}">${statusBadge.text}</span>`
    : "";
  return `
    <div class="tx-item">
      <div class="tx-icon ${amtClass}">${icon}</div>
      <div class="tx-body">
        <div class="tx-label">${label}</div>
        <div class="tx-date">${dateStr}</div>
        ${hashHtml}
      </div>
      <div class="tx-right">
        <div class="tx-amount ${amtClass}">${amtText}</div>
        ${badgeHtml}
      </div>
    </div>`;
}

async function loadTxHistory(uid, walletAddress) {
  const wrap = $("txHistory");
  const section = $("txSection");
  if (!wrap) return;

  const unified = [];

  // ── Firestore 거래 내역 ──
  try {
    const q = query(
      collection(db, "transactions"),
      where("uid", "==", uid),
      orderBy("createdAt", "desc"),
      limit(30)
    );
    const snap = await getDocs(q);
    snap.forEach((d) => {
      const tx = d.data();
      const cfg = TX_CONFIG[tx.type] || { label: tx.type, dir: "expense", icon: "📋" };

      // merchant_income: 가맹점명 + 수수료 정보를 label에 포함
      let label = cfg.label;
      if (tx.type === "merchant_income" && tx.merchantName) {
        const feePct = tx.feeBps != null ? ` (수수료 ${(tx.feeBps / 100).toFixed(0)}%)` : "";
        label = `🏪 ${tx.merchantName}${feePct}`;
      }
      if (tx.type === "pay_merchant" && tx.merchantName) {
        label = `🛒 ${tx.merchantName}`;
      }

      unified.push({
        sortTs: tx.createdAt?.toDate ? tx.createdAt.toDate().getTime() : 0,
        label,
        icon: cfg.icon,
        dir: cfg.dir,
        amountHex: txAmountHex(tx),
        dateStr: tx.createdAt?.toDate ? tx.createdAt.toDate().toLocaleString("ko-KR") : "-",
        txHash: tx.txHash || null,
        statusBadge: null,
      });
    });
  } catch (err) {
    console.warn("loadTxHistory Firestore:", err.message);
  }

  // ── 잭팟 인출 내역 (온체인 기반으로 전환됨, 현재 비활성화) ──
  // 추후 Firestore jackpot_winners 컬렉션에서 온체인 당첨 데이터 조회로 변경 예정
  if (false && walletAddress) {
    try {
      const j = await fetchJackpotJson(`/jackpot/my-claims?wallet=${encodeURIComponent(walletAddress)}&limit=50`);
      // ...기존 코드 유지
    } catch (err) {
      console.warn("loadTxHistory jackpot claims:", err.message);
    }
  }

  if (unified.length === 0) {
    if (section) section.style.display = "none";
    return;
  }

  // 날짜 내림차순 정렬
  unified.sort((a, b) => b.sortTs - a.sortTs);

  show("txSection", true);

  // 수입 / 지출 합계
  let totalIncome = 0, totalExpense = 0, incomeCount = 0, expenseCount = 0;
  unified.forEach((t) => {
    if (t.dir === "income") { totalIncome += t.amountHex; incomeCount++; }
    else if (t.dir === "expense") { totalExpense += t.amountHex; expenseCount++; }
  });

  const fmtSum = (v) => v.toLocaleString("ko-KR", { maximumFractionDigits: 4 }) + " HEX";

  const summary = $("txSummary");
  if (summary) {
    summary.style.display = "";
    const el = (id) => document.getElementById(id);
    if (el("txTotalIncome")) el("txTotalIncome").textContent = "+" + fmtSum(totalIncome);
    if (el("txTotalExpense")) el("txTotalExpense").textContent = "−" + fmtSum(totalExpense);
    if (el("txTotalIncomeCount")) el("txTotalIncomeCount").textContent = incomeCount + "건";
    if (el("txTotalExpenseCount")) el("txTotalExpenseCount").textContent = expenseCount + "건";
  }

  wrap.innerHTML = unified.map(renderTxItem).join("");
}

function formatWei(weiStr) {
  try {
    const n = parseFloat(BigInt(weiStr).toString()) / 1e18;
    return n.toFixed(4);
  } catch {
    return weiStr;
  }
}

function bindCreateWallet() {
  const btn = $("btnCreateWallet");
  if (!btn) return;

  btn.onclick = async () => {
    const mentorAddress = String($("createWalletMentorAddr")?.value || "").trim();
    if (!mentorAddress || !/^0x[0-9a-fA-F]{40}$/i.test(mentorAddress)) {
      alert("\uBA58\uD1A0 \uC9C0\uAC11 \uC8FC\uC18C\uB97C \uC62C\uBC14\uB974\uAC8C \uC785\uB825\uD558\uC138\uC694.\n\uC608: 0x\uB85C \uC2DC\uC791\uD558\uB294 42\uC790\uB9AC \uC8FC\uC18C");
      return;
    }

    btn.disabled = true;
    btn.textContent = "\uC0DD\uC131 \uC911...";
    try {
      const createWalletFn = httpsCallable(functions, "createWallet");
      const res = await createWalletFn({ mentorAddress });
      setText("walletAddress", res.data?.address || "\uC0DD\uC131\uB428");
      show("noWallet", false);
      show("walletInfo", true);
      show("metamaskWarning", false);
      btn.style.display = "none";
      alert("\uC218\uD0C1 \uC9C0\uAC11\uC774 \uC0DD\uC131\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
    } catch (err) {
      alert("\uC9C0\uAC11 \uC0DD\uC131 \uC2E4\uD328: " + err.message);
      btn.disabled = false;
      btn.textContent = "\uC9C0\uAC11 \uC0DD\uC131";
    }
  };
}

function bindConnectMetaMask(uid) {
  const btn = $("btnConnectMetaMask");
  if (!btn) return;
  if (!window.ethereum) {
    btn.style.display = "none";
    return;
  }

  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "\uC5F0\uACB0 \uC911...";
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const address = accounts[0];

      const msg = `Jump Platform \uC9C0\uAC11 \uC5F0\uACB0 \uD655\uC778\nUID: ${uid}`;
      const msgHex = "0x" + Array.from(new TextEncoder().encode(msg))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      await window.ethereum.request({ method: "personal_sign", params: [msgHex, address] });

      await setDoc(doc(db, "users", uid), { wallet: { address, type: "metamask" } }, { merge: true });

      setText("walletAddress", address);
      show("noWallet", false);
      show("walletInfo", true);
      show("btnCreateWallet", false);
      show("btnConnectMetaMask", false);
      loadOnChainData(uid);
    } catch (err) {
      if (err.code === 4001) {
        alert("\uC11C\uBA85\uC774 \uCDE8\uC18C\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      } else {
        alert("MetaMask \uC5F0\uACB0 \uC2E4\uD328: " + err.message);
      }
      btn.disabled = false;
      btn.textContent = "MetaMask \uC5F0\uACB0";
    }
  };
}

function bindLevelUp(uid) {
  const btn = $("btnLevelUp");
  if (!btn || btn._bound) return;
  btn._bound = true;

  btn.onclick = async () => {
    if (!confirm("\uB808\uBCA8\uC5C5\uC744 \uC9C4\uD589\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?\n\uC870\uAC74 \uCDA9\uC871 \uC2DC \uB808\uBCA8\uC774 \uC0C1\uC2B9\uD569\uB2C8\uB2E4.")) return;

    btn.disabled = true;
    btn.textContent = "\uCC98\uB9AC \uC911...";
    try {
      const fn = httpsCallable(functions, "requestLevelUp");
      const res = await fn();
      alert(`\uB808\uBCA8\uC5C5 \uC644\uB8CC! Lv.${res.data.newLevel}`);
      await loadOnChainData(uid);
    } catch (err) {
      alert("\uB808\uBCA8\uC5C5 \uC2E4\uD328: " + err.message);
      btn.disabled = false;
      btn.textContent = "Level Up";
    }
  };
}

function bindOnChainRegister(uid) {
  const btn = $("btnRegisterOnChain");
  if (!btn) return;

  btn.onclick = async () => {
    const mentorAddress = String($("mentorAddrInput")?.value || "").trim();
    if (!mentorAddress || !/^0x[0-9a-fA-F]{40}$/i.test(mentorAddress)) {
      alert("\uBA58\uD1A0 \uC9C0\uAC11 \uC8FC\uC18C\uB97C \uC62C\uBC14\uB974\uAC8C \uC785\uB825\uD558\uC138\uC694.\n\uC608: 0x\uB85C \uC2DC\uC791\uD558\uB294 42\uC790\uB9AC \uC8FC\uC18C");
      return;
    }

    btn.disabled = true;
    btn.textContent = "\uB4F1\uB85D \uC911...";
    try {
      const registerMember = httpsCallable(functions, "registerMember");
      await registerMember({ mentorAddress });
      show("onChainRegBox", false);
      setText("onChainStatus", "\uB4F1\uB85D \uC644\uB8CC \u2713");
      $("onChainStatus").style.color = "var(--accent)";
      await loadOnChainData(uid);
    } catch (err) {
      alert("\uC628\uCCB4\uC778 \uB4F1\uB85D \uC2E4\uD328: " + err.message);
      btn.disabled = false;
      btn.textContent = "\uB4F1\uB85D";
    }
  };
}

function bindDepositForm() {
  const form = $("depositForm");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amountKrw = Number($("depositAmount")?.value);
    const depositorName = String($("depositorName")?.value || "").trim();
    const btn = $("btnDeposit");

    if (!amountKrw || amountKrw < 10000) {
      alert("\uC785\uAE08 \uAE08\uC561\uC740 10,000\uC6D0 \uC774\uC0C1\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
      return;
    }
    if (!depositorName) {
      alert("\uC785\uAE08\uC790\uBA85\uC744 \uC785\uB825\uD574 \uC8FC\uC138\uC694.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "\uC694\uCCAD \uC911...";

    try {
      const requestDeposit = httpsCallable(functions, "requestDeposit");
      const res = await requestDeposit({ amountKrw, depositorName });
      const d = res.data;

      show("depositResult", true);
      setText("drRefCode", d.refCode);
      setText("drBank", d.bankInfo?.bank || "-");
      setText("drAccount", d.bankInfo?.account || "-");
      setText("drHolder", d.bankInfo?.holder || "-");
      setText("drAmount", (d.amountKrw || 0).toLocaleString() + "\uC6D0");

      const drParts = [(d.amountKrw || 0).toLocaleString() + "\uC6D0"];
      if (d.estimatedUsd != null) drParts.push("$" + Number(d.estimatedUsd).toFixed(2));
      if (d.estimatedVnd) drParts.push(d.estimatedVnd);
      setText("drHex", drParts.join(" / "));

      form.reset();
    } catch (err) {
      alert("\uCDA9\uC804 \uC694\uCCAD \uC2E4\uD328: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "\uC785\uAE08 \uC694\uCCAD";
    }
  });
}

function bindMentorRequest(uid) {
  const btn = $("btnMentorRequest");
  if (!btn || btn._bound) return;
  btn._bound = true;

  btn.onclick = async () => {
    const email = String($("mentorReqEmail")?.value || "").trim().toLowerCase();
    if (!email) {
      alert("\uBA58\uD1A0 \uC774\uBA54\uC77C\uC744 \uC785\uB825\uD574 \uC8FC\uC138\uC694.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "\uC694\uCCAD \uC911...";
    try {
      await setDoc(doc(db, "mentorRequests", uid), {
        uid,
        mentorEmail: email,
        requestedAt: serverTimestamp(),
        status: "pending",
      });
      show("mentorReqDone", true);
      show("btnMentorRequest", false);
      const emailEl = $("mentorReqEmail");
      if (emailEl) emailEl.disabled = true;
    } catch (err) {
      alert("\uBA58\uD1A0 \uC694\uCCAD \uC2E4\uD328: " + err.message);
      btn.disabled = false;
      btn.textContent = "\uBA58\uD1A0 \uC694\uCCAD";
    }
  };
}

async function loadMerchantsForSelect() {
  const sel = $("merchantPaySelect");
  if (!sel) return;

  try {
    const snap = await getDocs(collection(db, "merchants"));
    const list = [];

    snap.forEach((d) => {
      const m = d.data() || {};
      if (m.active !== false) {
        list.push({ id: d.id, name: m.name || d.id });
      }
    });

    if (!list.length) {
      sel.innerHTML = '<option value="">\uACB0\uC81C \uAC00\uB2A5\uD55C \uAC00\uB9F9\uC810\uC774 \uC5C6\uC2B5\uB2C8\uB2E4</option>';
      return;
    }

    sel.innerHTML =
      '<option value="">\uAC00\uB9F9\uC810\uC744 \uC120\uD0DD\uD558\uC138\uC694</option>' +
      list.map((m) => `<option value="${m.id}">${m.name}</option>`).join("");
  } catch (err) {
    sel.innerHTML = '<option value="">\uAC00\uB9F9\uC810 \uBAA9\uB85D \uC870\uD68C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4</option>';
    console.warn("loadMerchantsForSelect:", err.message);
  }
}

function buildMypageDropHtml(d) {
  const items = [];
  if (d.potionsAdded   > 0) items.push(`<img src="/assets/images/item/hp.png" style="width:26px;height:26px;vertical-align:middle;"> 빨간약 <b>+${d.potionsAdded}</b>`);
  if (d.mpPotionsAdded > 0) items.push(`<img src="/assets/images/item/mp.png" style="width:26px;height:26px;vertical-align:middle;"> 마법약 <b>+${d.mpPotionsAdded}</b>`);
  if (d.reviveAdded    > 0) items.push(`<img src="/assets/images/item/revive_ticket.png" onerror="this.src='/assets/images/item/hp.png'" style="width:26px;height:26px;vertical-align:middle;"> 부활권 <b>+${d.reviveAdded}</b>`);
  if (!items.length) return '';
  const jackpotBanner = d.isJackpot
    ? `<div style="text-align:center;font-size:1.1em;font-weight:800;color:#f59e0b;margin-bottom:6px;letter-spacing:2px;">🎰 JACKPOT!! 🎰</div>`
    : '';
  return `
    <div style="margin-top:10px;background:rgba(251,191,36,.12);border:1.5px solid #f59e0b;border-radius:10px;padding:10px 14px;">
      ${jackpotBanner}
      <div style="font-size:12px;color:#92400e;font-weight:700;margin-bottom:6px;">🎁 득템!</div>
      ${items.map(i=>`<div style="font-size:14px;margin:3px 0;">${i}</div>`).join('')}
    </div>`;
}

function watchJackpotResult(txHash, walletAddress) {
  // 온체인 기반 시스템으로 전환됨
  // 현재는 일반 결제 완료 알림만 표시
  // 향후: Firestore jackpot_winners 컬렉션 또는 온체인 이벤트로 당첨 감시
  
  const box = $("merchantPayJackpot");
  if (!box || !txHash) return;

  box.style.display = "";
  const waitEl  = box.querySelector(".jp-waiting");
  const winEl   = box.querySelector(".jp-win");
  const noWinEl = box.querySelector(".jp-nowin");
  
  if (waitEl)  waitEl.style.display  = "";
  if (winEl)   winEl.style.display   = "none";
  if (noWinEl) noWinEl.style.display = "none";

  // 2초 후 대기 표시 숨김
  setTimeout(() => {
    if (waitEl) waitEl.style.display = "none";
    if (noWinEl) noWinEl.style.display = "block";
    const randEl = box.querySelector(".jp-nowin-rand");
    if (randEl) randEl.textContent = "결제가 완료되었습니다. 잭팟 당첨 여부는 [마이페이지]에서 확인하세요.";
  }, 2000);
}

function bindMerchantPay(uid, walletAddress) {
  const form = $("merchantPayForm");
  if (!form || form._bound) return;
  form._bound = true;

  // 통화 변경 시 레이블/min/placeholder 업데이트
  form.querySelectorAll("input[name='merchantPayCurrencyRadio']").forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      const isVnd = r.value === "VND";
      const labelEl = $("merchantPayAmountLabel");
      const inputEl = $("merchantPayAmount");
      const hidden  = $("merchantPayCurrency");
      if (labelEl) labelEl.textContent = isVnd ? "결제 금액 (동 VND) *" : "결제 금액 (원 KRW) *";
      if (inputEl) {
        inputEl.min         = isVnd ? "10000" : "1000";
        inputEl.step        = isVnd ? "1000"  : "100";
        inputEl.placeholder = isVnd ? "예: 200000" : "예: 30000";
        inputEl.value       = "";
      }
      if (hidden) hidden.value = r.value;
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const merchantId = $("merchantPaySelect")?.value;
    const amount     = Number($("merchantPayAmount")?.value);
    const currency   = $("merchantPayCurrency")?.value || "VND";
    const isVnd      = currency === "VND";
    const btn        = $("btnMerchantPay");
    const resultBox  = $("merchantPayResult");

    if (!merchantId) {
      alert("가맹점을 선택해 주세요.");
      return;
    }

    if (isVnd) {
      if (!amount || amount < 10000) { alert("VND 최소 결제 금액은 10,000동입니다."); return; }
    } else {
      if (!amount || amount < 1000)  { alert("KRW 최소 결제 금액은 1,000원입니다."); return; }
    }

    const confirmMsg = isVnd
      ? `${amount.toLocaleString()}동 (VND)을 결제하시겠습니까?`
      : `${amount.toLocaleString()}원 (KRW)을 결제하시겠습니까?`;
    if (!confirm(confirmMsg)) return;

    btn.disabled = true;
    btn.textContent = "결제 중...";
    if (resultBox) resultBox.style.display = "none";

    const payload = isVnd
      ? { merchantId: Number(merchantId), amountVnd: amount, currency: "VND" }
      : { merchantId: Number(merchantId), amountKrw: amount, currency: "KRW" };

    try {
      const payFn = httpsCallable(functions, "payMerchantHex");
      const res = await payFn(payload);
      const d = res.data;

      const amountDisp = isVnd
        ? `${amount.toLocaleString()}동 (${d.amountHex} HEX)`
        : `${amount.toLocaleString()}원 (${d.amountHex} HEX)`;

      if (resultBox) {
        resultBox.style.display = "";
        resultBox.innerHTML = `
          <div class="mp-kv"><span class="k">가맹점</span><span class="v">${d.merchantName || ""}</span></div>
          <div class="mp-kv"><span class="k">결제 금액</span><span class="v accent">${amountDisp}</span></div>
          <div class="mp-kv"><span class="k">트랜잭션</span><span class="v mono" style="font-size:0.8em;">${(d.txHash || "").slice(0, 20)}...</span></div>
          <p class="hint" style="color:var(--accent); margin-top:6px;">결제가 완료되었습니다.</p>
          ${buildMypageDropHtml(d)}
        `;
      }

      form.reset();
      watchJackpotResult(d.txHash, walletAddress);
      loadTxHistory(uid);
      loadOnChainData(uid);
    } catch (err) {
      alert("\uACB0\uC81C \uC2E4\uD328: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "\uACB0\uC81C";
    }
  });
}


let __qrStream = null;
let __qrRaf = 0;

function stopQrScan() {
  if (__qrRaf) cancelAnimationFrame(__qrRaf);
  __qrRaf = 0;
  if (__qrStream) {
    __qrStream.getTracks().forEach((t) => t.stop());
    __qrStream = null;
  }
  const overlay = $("qrScanOverlay");
  if (overlay) overlay.classList.remove("active");
}

function parseQrPayload(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  try {
    const j = JSON.parse(text);
    return {
      merchantId: String(j.merchantId || j.merchant_id || j.id || "").trim(),
      merchantName: String(j.name || j.merchantName || j.merchant_name || "").trim(),
      amount: Number(j.amount || j.krw || j.vnd || 0) || null,
      currency: String(j.currency || "").toUpperCase() || null,
    };
  } catch {}

  try {
    const u = new URL(text);
    return {
      merchantId: String(u.searchParams.get("merchant") || u.searchParams.get("merchantId") || u.searchParams.get("id") || "").trim(),
      merchantName: String(u.searchParams.get("name") || "").trim(),
      amount: Number(u.searchParams.get("amount") || 0) || null,
      currency: String(u.searchParams.get("currency") || "").toUpperCase() || null,
    };
  } catch {}

  const mId =
    /merchantId\s*[:=]\s*([A-Za-z0-9_-]+)/i.exec(text)?.[1] ||
    /id\s*[:=]\s*([A-Za-z0-9_-]+)/i.exec(text)?.[1] ||
    "";
  const amount = Number(/amount\s*[:=]\s*([0-9.]+)/i.exec(text)?.[1] || 0) || null;
  const currency = (/(currency|cur)\s*[:=]\s*([A-Za-z]{3})/i.exec(text)?.[2] || "").toUpperCase() || null;
  if (!mId && !amount && !currency) return null;
  return { merchantId: mId, merchantName: "", amount, currency };
}

function showQrResult(msg, isError) {
  const box = $("qrResultState");
  if (!box) return;
  box.textContent = msg;
  box.style.cssText = `display:block!important;margin:8px 0;padding:10px 14px;border-radius:8px;border:1px solid;font-size:0.88rem;${isError ? "background:#fef2f2;border-color:#fca5a5;color:#991b1b;" : "background:#f0fdf4;border-color:#86efac;color:#166534;"}`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function applyQrResult(payload) {
  if (!payload) return false;
  const sel          = $("merchantPaySelect");
  const amountInput  = $("merchantPayAmount");
  const currencyHidden = $("merchantPayCurrency");
  const radioVnd     = $("merchantPayCurrencyVND");
  const radioKrw     = $("merchantPayCurrencyKRW");

  // ── 금액 즉시 반영 ──
  if (payload.amount && amountInput) {
    amountInput.value = String(Math.round(payload.amount));
  }

  // ── 통화 즉시 반영 ──
  if (payload.currency) {
    const cur = payload.currency === "KRW" ? "KRW" : "VND";
    if (currencyHidden) currencyHidden.value = cur;
    if (cur === "KRW" && radioKrw) radioKrw.checked = true;
    if (cur === "VND" && radioVnd) radioVnd.checked = true;
    const labelEl = $("merchantPayAmountLabel");
    const inputEl = amountInput;
    const isVnd = cur === "VND";
    if (labelEl) labelEl.textContent = isVnd ? "결제 금액 (동 VND) *" : "결제 금액 (원 KRW) *";
    if (inputEl) {
      inputEl.min         = isVnd ? "10000" : "1000";
      inputEl.step        = isVnd ? "1000"  : "100";
      inputEl.placeholder = isVnd ? "예: 200000" : "예: 30000";
    }
  }

  // ── 가맹점 매칭 ──
  const mid = String(payload.merchantId || "").trim();
  if (!mid || !sel) {
    showQrResult(`✅ 금액 ${payload.amount ? payload.amount.toLocaleString() : "-"} 반영 완료. 가맹점을 직접 선택해 주세요.`, false);
    sel?.focus();
    return true;
  }

  // 1) 이미 select에 있으면 바로 선택
  const existing = Array.from(sel.options).find(
    (o) => o.value && (String(o.value) === mid || Number(o.value) === Number(mid))
  );
  if (existing) {
    sel.value = existing.value;
    showQrResult(`✅ QR 스캔 완료 — 가맹점: ${existing.textContent}, 금액: ${payload.amount?.toLocaleString() || "-"}`, false);
    sel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return true;
  }

  // 2) Firestore에서 직접 조회
  showQrResult("가맹점 정보 조회 중...", false);
  try {
    const mSnap = await getDoc(doc(db, "merchants", mid));
    if (mSnap.exists()) {
      const mName = mSnap.data()?.name || mid;
      // 셀렉트에 옵션 추가 (없을 경우)
      let opt = Array.from(sel.options).find((o) => String(o.value) === mid);
      if (!opt) {
        opt = document.createElement("option");
        opt.value = mid;
        opt.textContent = mName;
        sel.appendChild(opt);
      }
      sel.value = mid;
      showQrResult(`✅ QR 스캔 완료 — 가맹점: ${mName}, 금액: ${payload.amount?.toLocaleString() || "-"}`, false);
      sel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return true;
    }
  } catch (e) {
    console.warn("QR merchant fetch failed:", e.message);
    showQrResult("가맹점 조회 실패 — 직접 선택해 주세요.", true);
    return false;
  }

  showQrResult(`가맹점(ID: ${mid})을 찾을 수 없습니다 — 직접 선택해 주세요.`, true);
  return false;
}

function bindQrScan() {
  const btnOpen = $("btnQrScan");
  const btnClose = $("btnCloseQr");
  const overlay = $("qrScanOverlay");
  const video = $("qrVideo");
  const canvas = $("qrCanvas");
  const state = $("qrScanState");
  if (!btnOpen || !btnClose || !overlay || !video || !canvas) return;

  btnClose.onclick = () => stopQrScan();

  btnOpen.onclick = async () => {
    try {
      if (state) state.textContent = "카메라 시작 중...";
      overlay.classList.add("active");

      __qrStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = __qrStream;
      await video.play();

      const onDetected = async (raw) => {
        if (__qrRaf) { cancelAnimationFrame(__qrRaf); __qrRaf = 0; }
        const payload = parseQrPayload(raw);
        console.log("[QR] raw:", raw, "parsed:", JSON.stringify(payload));
        if (state) state.textContent = `인식: ${raw.slice(0, 60)} | ID: ${payload?.merchantId || "없음"}`;
        if (payload && (payload.merchantId || payload.amount)) {
          await applyQrResult(payload);
        } else {
          showQrResult(`QR 파싱 실패 — 원본: ${raw.slice(0, 100)}`, true);
        }
        setTimeout(() => stopQrScan(), 800);
      };

      // ── BarcodeDetector (Android Chrome 83+ / 하드웨어 가속) ──
      if ("BarcodeDetector" in window) {
        if (state) state.textContent = "QR 코드를 사각형 안에 맞춰주세요";
        const bd = new BarcodeDetector({ formats: ["qr_code"] });
        let detecting = false;
        const detectTick = async () => {
          if (detecting) { __qrRaf = requestAnimationFrame(detectTick); return; }
          if (!video.videoWidth || !video.videoHeight) { __qrRaf = requestAnimationFrame(detectTick); return; }
          detecting = true;
          try {
            const codes = await bd.detect(video);
            if (codes.length > 0) {
              await onDetected(codes[0].rawValue);
              return;
            }
          } catch {}
          detecting = false;
          __qrRaf = requestAnimationFrame(detectTick);
        };
        __qrRaf = requestAnimationFrame(detectTick);
        return;
      }

      // ── jsQR 폴백 ──
      if (!window.jsQR) {
        if (state) state.textContent = "jsQR 라이브러리 로드 실패 — 페이지를 새로고침 해주세요.";
        return;
      }
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      let frameCount = 0;
      const tick = () => {
        if (!video.videoWidth || !video.videoHeight) { __qrRaf = requestAnimationFrame(tick); return; }
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const qr = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
        if (qr?.data) {
          onDetected(qr.data);
          return;
        }
        frameCount++;
        if (frameCount % 20 === 0 && state) {
          state.textContent = `스캔 중... (${Math.floor(frameCount / 20)}) QR 코드를 사각형 안에 맞춰주세요`;
        }
        __qrRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      if (state) state.textContent = "카메라 사용 실패";
      stopQrScan();
      alert("카메라 접근 실패: " + (err?.message || err));
    }
  };
}

let __jpClaimableHex = 0;

function jackpotEndpoints(path) {
  const base = String(window.__jackpotApiBase || "").trim().replace(/\/$/, "");
  if (base) return [`${base}${path}`];
  const host = (location.hostname || "").toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1";
  if (isLocal) return [`http://${host || "127.0.0.1"}:8787${path}`, path];
  return [path];
}

async function fetchJackpotJson(path, options = {}) {
  let lastErr = null;
  for (const url of jackpotEndpoints(path)) {
    try {
      const res = await fetch(url, {
        cache: "no-store",
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      if (!res.ok) {
        const msg = json?.message || json?.error || `HTTP_${res.status}`;
        throw new Error(msg);
      }
      if (!json) throw new Error("INVALID_JSON_RESPONSE");
      return json;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("JACKPOT_FETCH_FAILED");
}

function fmtHex(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0 HEX";
  return `${n.toLocaleString("ko-KR", { maximumFractionDigits: 4 })} HEX`;
}

function fmtFiat(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  const fx = window.__jackpotFx || {};
  const krw = Number(fx.krw) > 0 ? Number(fx.krw) : 1480;
  const vnd = Number(fx.vnd) > 0 ? Number(fx.vnd) : 26000;
  const krwVal = Math.round(n * krw).toLocaleString("ko-KR");
  const vndVal = Math.round(n * vnd).toLocaleString("ko-KR");
  return `\uC57D ${krwVal}\uC6D0 / ${vndVal} VND`;
}


async function loadJackpotWallet(wallet) {
  if (!wallet) return;
  show("jackpotWalletSection", true);
  try {
    const b = await fetchJackpotJson(`/jackpot/balance?wallet=${encodeURIComponent(wallet)}`);
    const d = b?.data || {};
    const claimable = Number(d.claimableHex || 0);
    const totalWon = Number(d.totalWonHex || 0);
    const totalClaimed = Number(d.totalClaimedHex || 0);
    __jpClaimableHex = claimable;

    setText("jpClaimableHex", fmtHex(claimable));
    setText("jpClaimableRate", fmtFiat(claimable));
    setText("jpTotalWonHex", fmtHex(totalWon));
    setText("jpTotalWonRate", fmtFiat(totalWon));
    setText("jpTotalClaimedHex", fmtHex(totalClaimed));
    show("jpClaimableRateRow", true);
    show("jpTotalWonRateRow", true);
    show("jpWithdrawBox", true);
  } catch (e) {
    setText("jpClaimableHex", "\uC870\uD68C \uC2E4\uD328");
    console.warn("loadJackpotWallet failed:", e.message);
  }
}


async function requestJackpotWithdraw(wallet, amountHex) {
  const result = $("jpWithdrawResult");
  if (result) {
    result.style.display = "";
    result.innerHTML = "<p class='hint'>\uC778\uCD9C \uC694\uCCAD \uCC98\uB9AC \uC911...</p>";
  }
  const j = await fetchJackpotJson("/jackpot/withdraw", {
    method: "POST",
    body: JSON.stringify({ wallet, amountHex: String(amountHex) }),
  });
  if (result) {
    const tx = j?.data?.txHash ? String(j.data.txHash).slice(0, 18) + "..." : "-";
    result.innerHTML = `<p class=\"hint\" style=\"color:var(--accent)\">\uC778\uCD9C \uC694\uCCAD \uC644\uB8CC (\uC0C1\uD0DC: ${j?.data?.status || "-"}, TX: ${tx})</p>`;
  }
  await loadJackpotWallet(wallet);
}

function bindJackpotActions(wallet) {
  const btnRefresh = $("btnRefreshJackpotWallet");
  if (btnRefresh) btnRefresh.onclick = () => loadJackpotWallet(wallet);

  const btnWithdraw = $("btnJackpotWithdraw");
  if (btnWithdraw) {
    btnWithdraw.onclick = async () => {
      const val = String($("jpWithdrawAmount")?.value || "").trim();
      const amount = val ? Number(val) : __jpClaimableHex;
      if (!amount || amount <= 0) {
        alert("인출 가능 잔액이 없습니다.");
        return;
      }
      if (amount < 10) {
        alert("잭팟 인출은 최소 10 HEX 이상부터 가능합니다.\n현재 잔액: " + amount.toFixed(4) + " HEX");
        return;
      }
      try {
        await requestJackpotWithdraw(wallet, amount);
      } catch (e) {
        const result = $("jpWithdrawResult");
        if (result) {
          result.style.display = "";
          result.innerHTML = `<p class=\"hint muted\">\uC778\uCD9C \uC2E0\uCCAD \uC2E4\uD328: ${e.message}</p>`;
        }
      }
    };
  }

  const btnConvert = $("btnJackpotConvertInHistory");
  if (btnConvert) {
    btnConvert.onclick = async () => {
      if (!__jpClaimableHex || __jpClaimableHex <= 0) {
        alert("인출 가능 잔액이 없습니다.");
        return;
      }
      if (__jpClaimableHex < 10) {
        alert("잭팟 인출은 최소 10 HEX 이상부터 가능합니다.\n현재 잔액: " + __jpClaimableHex.toFixed(4) + " HEX");
        return;
      }
      try {
        await requestJackpotWithdraw(wallet, __jpClaimableHex);
      } catch (e) {
        alert("HEX \uC804\uD658 \uC2E4\uD328: " + e.message);
      }
    };
  }
}
onAuthReady(async (ctx) => {
  const loggedIn = (ctx?.loggedIn ?? ctx?.loggedin) === true;
  const user = ctx?.user;

  if (!loggedIn || !user) {
    show("needLoginPanel", true);
    const btn = $("btnLoginPage");
    if (btn) {
      btn.onclick = async () => {
        try {
          await login();
        } catch (e) {
          console.warn(e);
        }
      };
    }
    return;
  }

  show("mainContent", true);

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? snap.data() : {};

    if (!data.name) {
      show("noProfilePanel", true);
      return;
    }

    const walletAddress = data?.wallet?.address ? String(data.wallet.address) : '';

    renderProfile(data, user);
    renderWallet(data);
    bindCreateWallet();
    bindConnectMetaMask(user.uid);
    bindOnChainRegister(user.uid);
    bindLevelUp(user.uid);
    bindMentorRequest(user.uid);
    bindDepositForm();
    await loadMerchantsForSelect();
    bindMerchantPay(user.uid, walletAddress);
    bindQrScan();

    // URL 파라미터 처리 (앱 네이티브 카메라로 QR 스캔 시 merchant=?&amount=?&currency=? 진입)
    (async () => {
      const p = new URLSearchParams(location.search);
      const mid = (p.get("merchant") || p.get("merchantId") || p.get("id") || "").trim();
      const amt = Number(p.get("amount") || 0) || null;
      const cur = (p.get("currency") || "").toUpperCase() || null;
      if (mid || amt) {
        await applyQrResult({ merchantId: mid, merchantName: "", amount: amt, currency: cur });
        $("qrResultState")?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    })();

    loadOnChainData(user.uid);
    loadDepositHistory(user.uid);
    loadMentees();

    loadTxHistory(user.uid, walletAddress);

    if (walletAddress) {
      bindJackpotActions(walletAddress);
      loadJackpotWallet(walletAddress);
    }

    const btnRefresh = $("btnRefreshDeposits");
    if (btnRefresh) btnRefresh.onclick = () => loadDepositHistory(user.uid);

    const btnRefreshTx = $("btnRefreshTx");
    if (btnRefreshTx) btnRefreshTx.onclick = () => loadTxHistory(user.uid, walletAddress);

    const btnRefreshMentees = $("btnRefreshMentees");
    if (btnRefreshMentees) btnRefreshMentees.onclick = () => loadMentees();
  } catch (err) {
    console.error("\uB9C8\uC774\uD398\uC774\uC9C0 \uCD08\uAE30\uD654 \uC2E4\uD328", err);
  }
});

// ── 앱 캐시 초기화 ──
(function bindClearCache() {
  const btn = $("btnClearCache");
  const msg = $("clearCacheMsg");
  if (!btn) return;

  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "초기화 중...";

    try {
      // 1) Service Worker 캐시 전체 삭제
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }

      // 2) Service Worker 등록 해제
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }

      // 3) localStorage / sessionStorage 초기화
      localStorage.clear();
      sessionStorage.clear();

      if (msg) {
        msg.style.display = "";
        msg.textContent = "캐시가 삭제되었습니다. 3초 후 새로고침...";
      }

      setTimeout(() => {
        // 강제 새로고침 (캐시 무시)
        location.href = location.pathname + "?v=" + Date.now();
      }, 3000);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "🔄 앱 캐시 초기화 (문제 발생 시)";
      if (msg) { msg.style.display = ""; msg.textContent = "초기화 실패: " + err.message; }
    }
  };
})();
