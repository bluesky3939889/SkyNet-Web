"use strict";

const config = window.SKYNET_PUBLIC_CONFIG;
const params = new URLSearchParams(location.hash.slice(1));
let token = params.get("type") === "invite" ? params.get("access_token") : null;
history.replaceState(null, "", location.pathname);

const form = document.getElementById("activate");
const status = document.getElementById("status");
const password = document.getElementById("password");
const submit = form.querySelector("button");
if (token && config?.url && config?.key) {
  form.hidden = false;
} else {
  status.textContent = "邀請連結無效或已過期，請聯絡管理員。";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!token || submit.disabled) return;
  submit.disabled = true;
  status.textContent = "正在設定密碼…";
  try {
    const response = await fetch(config.url + "/auth/v1/user", {
      method: "PUT",
      headers: {
        apikey: config.key,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: password.value }),
      redirect: "error",
    });
    if (response.ok) {
      token = null;
      password.value = "";
      form.hidden = true;
      status.textContent = "密碼已設定，請返回網頁登入。";
    } else if (response.status === 401 || response.status === 403) {
      token = null;
      password.value = "";
      form.hidden = true;
      status.textContent = "邀請連結已過期，請聯絡管理員。";
    } else {
      status.textContent = "無法設定密碼，請確認密碼符合要求後再試。";
    }
  } catch {
    status.textContent = "連線失敗，請稍後再試。";
  } finally {
    submit.disabled = false;
  }
});
