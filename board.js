/* SKYNET_GITHUB_VIEWER */
"use strict";
const element = id => document.getElementById(id);
const clock = new Intl.DateTimeFormat("zh-TW", {timeZone: "Asia/Taipei", timeStyle: "medium"});
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const header = "# SkyNet 人員偵測紀錄\n\n最近 100 筆，時間為台北時間。\n\n";
const loginKey = "skynet-viewer-login";
const rememberDuration = 30 * 24 * 60 * 60 * 1000;
let session = null;
let timer;
let controller;
let busy = false;
let resumeAt = 0;

function status(message, error = false) {
  element("status").textContent = message;
  element("status").dataset.error = String(error);
}

function decodeName(value) {
  return value.replace(/&#(\d+);/g, (entity, digits) => {
    const code = Number(digits);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function parseFeed(document) {
  if (!document.startsWith(header)) throw new Error("紀錄格式不同，請確認使用 SkyNet 偵測資料儲存庫。");
  const lines = document.slice(header.length).trimEnd();
  if (!lines) return [];
  const rows = lines.split("\n");
  if (rows.length > 100) throw new Error("紀錄超出 100 筆，請確認 Client 版本。");
  return rows.map(line => {
    const match = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) ｜ (.*?) ｜ (.*) ｜ (出現|離開) <!-- skynet:([0-9a-f]{32}) -->$/.exec(line);
    if (!match) throw new Error("紀錄格式無法讀取，請確認 Client 版本。");
    return {time: match[1], device: decodeName(match[2]), name: decodeName(match[3]), kind: match[4]};
  });
}

async function request(current, suffix) {
  controller = new AbortController();
  const timeout = setTimeout(() => controller?.abort(), 12000);
  try {
    const response = await fetch("https://api.github.com/repos/" + current.repo + suffix, {
      headers: {Authorization: "Bearer " + current.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10"},
      cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const limited = response.status === 429 || (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit|abuse/i.test(body.message || "")));
      if (limited) {
        const reset = response.headers.get("x-ratelimit-remaining") === "0" ? Number(response.headers.get("x-ratelimit-reset")) * 1000 : 0;
        const retry = Number(response.headers.get("retry-after")) * 1000;
        const retryAt = Math.max(Date.now() + 60000, reset || 0, Date.now() + retry);
        throw Object.assign(new Error("GitHub 暫時限制查詢，將於 " + clock.format(new Date(retryAt)) + " 後重試。"), {retryAt});
      }
      throw Object.assign(new Error("GitHub 讀取失敗（HTTP " + response.status + "）。"), {status: response.status});
    }
    const result = await response.json();
    if (session !== current) throw new DOMException("Session ended", "AbortError");
    return result;
  } finally {
    clearTimeout(timeout);
    controller = null;
  }
}

function render(rows) {
  element("events").replaceChildren(...rows.map(event => {
    const row = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = event.name;
    const badge = document.createElement("span");
    badge.className = event.kind === "出現" ? "enter" : "leave";
    badge.textContent = event.kind;
    const detail = document.createElement("small");
    detail.textContent = event.device + " · " + event.time;
    row.append(title, badge, detail);
    return row;
  }));
  element("count").textContent = rows.length;
  element("empty").hidden = rows.length > 0;
  element("latest").textContent = rows.length ? "最新事件時間　" + rows[0].time : "";
}

function signOut(message = "已登出，已清除記住的登入。", error = false, forget = true) {
  session = null;
  clearTimeout(timer);
  controller?.abort();
  element("token").value = "";
  element("events").replaceChildren();
  element("checked").textContent = element("latest").textContent = "";
  element("feed").hidden = element("logout").hidden = true;
  element("auth").hidden = false;
  if (forget) {
    try {
      localStorage.removeItem(loginKey);
      element("forget").hidden = true;
    } catch {
      message += " 此瀏覽器無法清除登入資料，請至瀏覽器設定清除此網站的資料。";
    }
    element("remember").checked = false;
  }
  status(message, error);
}

async function refresh() {
  clearTimeout(timer);
  const current = session;
  if (!current || document.hidden) return;
  if (busy) {
    timer = setTimeout(refresh, 100);
    return;
  }
  if (Date.now() < resumeAt) {
    timer = setTimeout(refresh, resumeAt - Date.now());
    return;
  }
  busy = true;
  element("refresh").disabled = element("connect").disabled = element("remember").disabled = true;
  try {
    if (!current.verified) {
      const metadata = await request(current, "");
      if (metadata.private !== true || metadata.visibility !== "private") {
        signOut("偵測資料儲存庫必須為 Private，請確認輸入的是私人資料儲存庫。", true);
        return;
      }
      current.verified = true;
    }
    let saved;
    try {
      saved = await request(current, "/contents/events.md");
    } catch (error) {
      if (error.status !== 404) throw error;
      saved = null;
    }
    if (session !== current) return;
    let rows = [];
    if (saved) {
      if (saved.encoding !== "base64" || typeof saved.content !== "string" || saved.content.length > 700000) {
        throw new Error("紀錄檔無法讀取，請確認 Client 版本。");
      }
      const bytes = Uint8Array.from(atob(saved.content.replace(/\s/g, "")), character => character.charCodeAt(0));
      rows = parseFeed(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    }
    render(rows);
    if (current.remember && !current.saved) {
      try {
        localStorage.setItem(loginKey, JSON.stringify({repo: current.repo, token: current.token,
          expiresAt: Date.now() + rememberDuration}));
        current.saved = true;
        current.storageError = false;
        element("forget").hidden = false;
      } catch {
        current.remember = false;
        current.storageError = true;
      }
    }
    element("auth").hidden = true;
    element("feed").hidden = element("logout").hidden = false;
    element("checked").textContent = "最近成功查詢　" + clock.format(new Date());
    const message = saved ? "已連線 · 每 10 秒自動更新" : "已連線 · 等待 Client 首次上傳";
    status(current.storageError ? message + "。此瀏覽器無法記住登入。" : message, Boolean(current.storageError));
  } catch (error) {
    if (session !== current) return;
    if ([401, 403, 404].includes(error.status)) {
      signOut("無法讀取此私人儲存庫，請確認帳號/儲存庫名稱、Token 效期及 Contents 唯讀權限。", true);
    } else if (error.retryAt) {
      resumeAt = error.retryAt;
      status(error.message, true);
    } else {
      status(error.name === "AbortError" ? "查詢已暫停或逾時，將再次嘗試。" :
        error instanceof TypeError ? "網路連線失敗，將再次嘗試。" : error.message, true);
    }
  } finally {
    busy = false;
    element("refresh").disabled = element("connect").disabled = element("remember").disabled = false;
    if (session === current && !document.hidden) timer = setTimeout(refresh, Math.max(10000, resumeAt - Date.now()));
  }
}

element("connect-form").addEventListener("submit", event => {
  event.preventDefault();
  if (busy) return;
  const repo = element("repo").value.trim();
  const token = element("token").value.trim();
  if (!repositoryPattern.test(repo) || !token || /\s/.test(token)) {
    status("請填入帳號/私人儲存庫名稱及有效的查看用 Token。", true);
    return;
  }
  session = {repo, token, verified: false, remember: element("remember").checked, saved: false};
  element("token").value = "";
  try {
    localStorage.removeItem(loginKey);
    element("forget").hidden = true;
    localStorage.setItem("skynet-viewer-repo", repo);
  } catch {
    session.storageError = true;
  }
  status("正在驗證並讀取偵測紀錄…");
  refresh();
});
element("logout").addEventListener("click", () => signOut());
element("forget").addEventListener("click", () => {
  signOut("已清除此裝置登入，請重新連線。");
});
element("refresh").addEventListener("click", refresh);
document.addEventListener("visibilitychange", () => {
  clearTimeout(timer);
  if (document.hidden) controller?.abort();
  else refresh();
});
window.addEventListener("pagehide", () => signOut("請重新連線。", false, false));
window.addEventListener("pageshow", event => {
  if (event.persisted) restoreLogin();
});
window.addEventListener("storage", event => {
  if ((event.key === loginKey || event.key === null) && session) {
    signOut("此瀏覽器的登入記憶已變更，請重新連線。", false, false);
    element("forget").hidden = event.newValue === null;
  }
});

function restoreLogin() {
  try {
    const raw = localStorage.getItem(loginKey);
    if (!raw) return;
    element("forget").hidden = false;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved.repo !== "string" || !repositoryPattern.test(saved.repo) || typeof saved.token !== "string" ||
        !saved.token || /\s/.test(saved.token) || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now()) {
      signOut("記住的登入已到期或無法讀取，請重新連線。");
      return;
    }
    element("repo").value = saved.repo;
    element("remember").checked = true;
    session = {repo: saved.repo, token: saved.token, verified: false, saved: true};
    status("正在使用此裝置記住的登入連線…");
    refresh();
  } catch {
    signOut("無法讀取記住的登入，請重新連線。");
  }
}

try { element("repo").value = localStorage.getItem("skynet-viewer-repo") || ""; } catch {}
restoreLogin();
