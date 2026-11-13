"use strict";
const $ = id => document.getElementById(id);
const storageKey = "skynet-supabase-session-v1";
const configKey = "skynet-supabase-project-v1";
const clock = new Intl.DateTimeFormat("zh-TW", {timeZone:"Asia/Taipei", dateStyle:"medium", timeStyle:"medium"});
let active = null, refreshFlight = null, generation = 0;

function status(text, error=false) { $("status").textContent=text; $("status").dataset.error=String(error); }
function validateProject(url,key) {
  url=url.trim().replace(/\/$/, ""); key=key.trim();
  if (!/^https:\/\/[a-z0-9-]{6,80}\.supabase\.co$/.test(url)) throw new Error("請填入正確的 Supabase Project URL。");
  let valid=/^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!valid) { try { valid=key.split(".").length===3 && JSON.parse(atob(key.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).role==="anon"; } catch {} }
  if (!valid) throw new Error("請使用 publishable／anon key，不能使用 secret／service_role key。");
  return {url,key};
}
async function api(session,path,data=null,access="",method=data===null?"GET":"POST") {
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),12000);
  const headers={apikey:session.key,"Content-Type":"application/json"};
  if (access) headers.Authorization="Bearer "+access;
  try {
    const response=await fetch(session.url+path,{method,headers,
      body:data===null?null:JSON.stringify(data),signal:controller.signal,redirect:"error",credentials:"omit",cache:"no-store"});
    if (!response.ok) throw Object.assign(new Error("HTTP "+response.status),{status:response.status});
    return response.status===204 ? null : await response.json();
  } finally { clearTimeout(timeout); }
}
function persist(session) {
  if (active!==session) return;
  const saved={url:session.url,key:session.key,owner:session.owner,refresh:session.refresh,remember:session.remember};
  try {
    sessionStorage.removeItem(storageKey); localStorage.removeItem(storageKey);
    (session.remember?localStorage:sessionStorage).setItem(storageKey,JSON.stringify(saved));
  } catch { status("瀏覽器無法保存登入；關閉此頁後需重新登入。",true); }
}
async function token(session,force=false) {
  if (!force && session.access && session.expires>Date.now()+45000) return session.access;
  if (refreshFlight?.session===session) return refreshFlight.promise;
  const promise=(async()=>{
    const result=await api(session,"/auth/v1/token?grant_type=refresh_token",{refresh_token:session.refresh});
    if (active!==session) throw new DOMException("Session changed","AbortError");
    if (result.user?.id!==session.owner) throw Object.assign(new Error("登入身分不同"),{status:401});
    session.refresh=result.refresh_token; session.access=result.access_token;
    session.expires=Date.now()+Number(result.expires_in||3600)*1000;
    persist(session); return session.access;
  })();
  refreshFlight={session,promise};
  try { return await promise; } finally { if (refreshFlight?.promise===promise) refreshFlight=null; }
}
function resetView() { window.skynetRadar?.reset(); }
function endSession(message="已登出。") {
  ++generation;const old=active;active=null;refreshFlight=null;resetView();
  $("auth").hidden=false;$("logout").hidden=true;$("password").value="";
  $("password-change").hidden=true;
  $("password-change-form").reset();
  try {localStorage.removeItem(storageKey);sessionStorage.removeItem(storageKey);} catch {}
  status(message);
  return old;
}
function showFeed() {$("auth").hidden=true;$("logout").hidden=false;window.skynetRadar?.show();}
async function openSession(session, user) {
  if (active!==session) return;
  if (user.app_metadata?.skynet_initial_password === true) {
    $("auth").hidden=true;
    $("logout").hidden=$("password-change").hidden=false;
    status("請更換管理員提供的初始密碼。");
    $("new-password").focus();
    return;
  }
  $("password-change").hidden=true;
  showFeed();

}
$("password-change-form").addEventListener("submit", async event => {
  event.preventDefault();
  const session=active, button=$("save-password"), password=$("new-password").value;
  if (!session || button.disabled) return;
  if (password!==$("confirm-password").value || [...password].length<12 ||
      new TextEncoder().encode(password).length>72) {
    status("請確認兩次密碼一致，至少 12 個字元且最多 72 位元組。",true);
    return;
  }
  button.disabled=true;
  try {
    const access=await token(session);
    await api(session,"/auth/v1/user",{password},access,"PUT");
    if (active!==session) return;
    const ready=await api(session,"/rest/v1/rpc/skynet_password_ready",{},access).catch(()=>null);
    if (active!==session) return;
    const message=ready===false
      ?"密碼已更新。首次登入限制仍在，請管理員檢查 Supabase 的換密碼觸發器。"
      :"密碼已更新，請使用新密碼登入。";
    const old=endSession(message);
    if (old?.access) api(old,"/auth/v1/logout?scope=local",{},old.access).catch(()=>{});
  } catch (error) {
    if (active===session) status(error.status===422
      ?"請使用與初始密碼不同、符合專案規則的新密碼。":"無法更換密碼，請重新登入後再試。",true);
  } finally {
    button.disabled=false;
  }
});
$("login-form").addEventListener("submit",async event=>{
  event.preventDefault();
  if ($("login").disabled) return;
  let project;
  try {project=validateProject($("url").value,$("key").value);}
  catch(error) {$("project-settings").open=true;status(error.message,true);return;}
  const email=$("email").value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {status("請輸入完整 Email，例如 name@example.com；不能只填帳號名稱。",true);return;}
  if (!$("password").value) {status("請輸入看板帳號的密碼。",true);return;}
  const nonce=++generation;$("login").disabled=true;$("login").textContent="正在登入…";
  status("正在連線 Supabase 驗證帳號，最長約 12 秒…");
  try {
    const result=await api(project,"/auth/v1/token?grant_type=password",{email,password:$("password").value});
    if (nonce!==generation) return;
    if (!result.user?.id||!result.refresh_token||!result.access_token) throw new Error("invalid_session");
    resetView();active={...project,owner:result.user.id,refresh:result.refresh_token,access:result.access_token,
      expires:Date.now()+Number(result.expires_in||3600)*1000,remember:$("remember").checked};
    persist(active);try {localStorage.setItem(configKey,JSON.stringify(project));} catch {}
    $("password").value="";await openSession(active,result.user);
  } catch(error) {
    if (nonce===generation) status(error.status?`登入失敗（HTTP ${error.status}），請核對專案與看板帳號密碼，並確認使用者已確認 Email。`:
      error.name==="AbortError"?"登入連線超過 12 秒，請確認網路與 Supabase 專案是否已啟用。":
      error.message==="Failed to fetch"?"無法連線，請確認網路、Project URL 與專案是否啟用。":"登入未完成，請重新整理後再試。",true);
  }
  finally {$("login").disabled=false;$("login").textContent="登入看板";}
});
$("logout").addEventListener("click",()=>{const old=endSession();if(old?.access) api(old,"/auth/v1/logout",{},old.access).catch(()=>{});});
(async function restore(){
  status("登入程式已就緒，請輸入看板 Email 與密碼。");
  let project=window.SKYNET_PUBLIC_CONFIG||{};
  try {if(!project.url) project=JSON.parse(localStorage.getItem(configKey)||"{}");} catch {}
  $("url").value=project.url||"";$("key").value=project.key||"";
  // Official builds carry only public endpoint data.  Normal users therefore
  // see an account-only form; the details remain available for a local legacy
  // deployment that has no embedded project configuration.
  $("project-settings").hidden=Boolean(project.url&&project.key);
  $("project-settings").open=!project.url;
  try {
    const saved=JSON.parse(sessionStorage.getItem(storageKey)||localStorage.getItem(storageKey)||"null");
    if(!saved) return;
    validateProject(saved.url,saved.key);
    if(!saved.owner||!saved.refresh) return;
    if(project.url&&project.url!==saved.url) {localStorage.removeItem(storageKey);sessionStorage.removeItem(storageKey);return;}
    active={...saved,access:"",expires:0};$("remember").checked=Boolean(saved.remember);
    const session=active;
    const user=await api(session,"/auth/v1/user",null,await token(session));
    await openSession(session,user);
  } catch {if (!generation) endSession("請重新登入。");}
})();
