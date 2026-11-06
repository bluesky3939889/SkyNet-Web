"use strict";
const $ = id => document.getElementById(id);
const storageKey = "skynet-supabase-session-v1";
const configKey = "skynet-supabase-project-v1";
const clock = new Intl.DateTimeFormat("zh-TW", {timeZone:"Asia/Taipei", dateStyle:"medium", timeStyle:"medium"});
let active = null, timer = null, busy = false, refreshFlight = null, generation = 0;
let rows = [], cursor = "", signature = "";

function status(text, error=false) { $("status").textContent=text; $("status").dataset.error=String(error); }
function validateProject(url,key) {
  url=url.trim().replace(/\/$/, ""); key=key.trim();
  if (!/^https:\/\/[a-z0-9-]{6,80}\.supabase\.co$/.test(url)) throw new Error("請填入正確的 Supabase Project URL。");
  let valid=/^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!valid) { try { valid=key.split(".").length===3 && JSON.parse(atob(key.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).role==="anon"; } catch {} }
  if (!valid) throw new Error("請使用 publishable／anon key，不能使用 secret／service_role key。");
  return {url,key};
}
async function api(session,path,data=null,access="") {
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),12000);
  const headers={apikey:session.key,"Content-Type":"application/json"};
  if (access) headers.Authorization="Bearer "+access;
  try {
    const response=await fetch(session.url+path,{method:data===null?"GET":"POST",headers,
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
function resetView() {
  rows=[];cursor="";signature="";$("events").replaceChildren();$("count").textContent="0";
  $("checked").textContent="";$("search").value="";
  $("device").replaceChildren(new Option("全部裝置",""));
}
function endSession(message="已登出。") {
  ++generation;const old=active;active=null;clearTimeout(timer);refreshFlight=null;resetView();
  $("auth").hidden=false;$("feed").hidden=$("logout").hidden=true;$("password").value="";
  try {localStorage.removeItem(storageKey);sessionStorage.removeItem(storageKey);} catch {}
  status(message);
  return old;
}
function showFeed() {$("auth").hidden=true;$("feed").hidden=$("logout").hidden=false;}
function render() {
  const device=$("device").value, query=$("search").value.trim().toLocaleLowerCase();
  const filtered=rows.filter(row=>(!device||row.device===device)&&(!query||row.name.toLocaleLowerCase().includes(query)));
  const next=JSON.stringify(filtered);
  if (next===signature) return;
  signature=next;
  $("events").replaceChildren(...filtered.map(event=>{
    const li=document.createElement("li"),title=document.createElement("strong"),badge=document.createElement("span"),detail=document.createElement("small");
    title.textContent=event.name;badge.className=event.kind==="enter"?"enter":"leave";badge.textContent=event.kind==="enter"?"出現":"離開";
    detail.textContent=event.device+" · "+clock.format(new Date(event.occurred_at));li.append(title,badge,detail);return li;
  }));
  $("count").textContent=String(filtered.length);$("empty").hidden=filtered.length>0;
}
async function refresh() {
  clearTimeout(timer);
  const session=active;
  if (!session||busy||document.hidden) return;
  busy=true;$("refresh").disabled=true;
  try {
    const query=new URLSearchParams({select:"id,user_id,occurred_at,created_at,device,name,kind",user_id:"eq."+session.owner,order:"created_at.desc,id.desc",limit:"100"});
    if (cursor) query.set("created_at","gte."+cursor);
    let result;
    for (let attempt=0;attempt<2;attempt++) {
      try {result=await api(session,"/rest/v1/skynet_events?"+query,null,await token(session,Boolean(attempt)));break;}
      catch(error) {if (error.status!==401||attempt) throw error;}
    }
    if (active!==session) return;
    if (!Array.isArray(result)||result.some(e=>e.user_id!==session.owner||typeof e.id!=="string"||typeof e.name!=="string"||typeof e.device!=="string"||!["enter","leave"].includes(e.kind)||!Number.isFinite(Date.parse(e.occurred_at))||!Number.isFinite(Date.parse(e.created_at)))) throw new Error("資料格式或權限與登入帳號不符");
    if (result.length) cursor=result[0].created_at;
    const combined=new Map(rows.map(e=>[e.id,e]));for (const row of result) combined.set(row.id,row);
    rows=[...combined.values()].sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id)).slice(0,100);
    rows.sort((a,b)=>Date.parse(b.occurred_at)-Date.parse(a.occurred_at));
    const devices=[...new Set(rows.map(r=>r.device))].sort();const previous=$("device").value;
    if (JSON.stringify(devices)!==JSON.stringify([...$("device").options].slice(1).map(o=>o.value))) {
      $("device").replaceChildren(new Option("全部裝置",""),...devices.map(d=>new Option(d,d)));
      if (devices.includes(previous)) $("device").value=previous;
    }
    render();$("checked").textContent="最後查詢　"+clock.format(new Date());status("已連線 · 只顯示此帳號的資料");
  } catch (error) {
    if (active!==session) return;
    if ([400,401].includes(error.status)) endSession("登入已失效，請重新輸入 Email 與密碼。Client 的待傳紀錄會保留。");
    else status(error.status===403?"權限不足，請確認已執行 schema.sql。":"暫時無法更新，保留目前畫面並稍後重試。",true);
  } finally {
    busy=false;$("refresh").disabled=false;
    if (active&&!document.hidden) timer=setTimeout(refresh,5000);
  }
}
$("login-form").addEventListener("submit",async event=>{
  event.preventDefault();const nonce=++generation;$("login").disabled=true;
  try {
    const project=validateProject($("url").value,$("key").value);
    const result=await api(project,"/auth/v1/token?grant_type=password",{email:$("email").value.trim(),password:$("password").value});
    if (nonce!==generation) return;
    if (!result.user?.id||!result.refresh_token||!result.access_token) throw new Error("invalid_session");
    resetView();active={...project,owner:result.user.id,refresh:result.refresh_token,access:result.access_token,
      expires:Date.now()+Number(result.expires_in||3600)*1000,remember:$("remember").checked};
    persist(active);try {localStorage.setItem(configKey,JSON.stringify(project));} catch {}
    $("password").value="";showFeed();status("登入成功，正在讀取紀錄…");await refresh();
  } catch(error) {if (nonce===generation) status(error.status?"登入失敗，請核對專案與帳號密碼。":error.message==="Failed to fetch"?"無法連線，請確認網路與專案是否啟用。":error.message,true);}
  finally {$("login").disabled=false;}
});
$("logout").addEventListener("click",()=>{const old=endSession();if(old?.access) api(old,"/auth/v1/logout",{},old.access).catch(()=>{});});
$("refresh").addEventListener("click",refresh);$("device").addEventListener("change",render);$("search").addEventListener("input",render);
document.addEventListener("visibilitychange",()=>{clearTimeout(timer);if(!document.hidden) refresh();});
window.addEventListener("pagehide",()=>clearTimeout(timer));
window.addEventListener("pageshow",()=>{if(active&&!document.hidden)refresh();});
(function restore(){
  let project=window.SKYNET_PUBLIC_CONFIG||{};
  try {if(!project.url) project=JSON.parse(localStorage.getItem(configKey)||"{}");} catch {}
  $("url").value=project.url||"";$("key").value=project.key||"";
  $("project-settings").open=!project.url;
  try {
    const saved=JSON.parse(sessionStorage.getItem(storageKey)||localStorage.getItem(storageKey)||"null");
    if(!saved) return;
    validateProject(saved.url,saved.key);
    if(!saved.owner||!saved.refresh) return;
    if(project.url&&project.url!==saved.url) {localStorage.removeItem(storageKey);sessionStorage.removeItem(storageKey);return;}
    active={...saved,access:"",expires:0};$("remember").checked=Boolean(saved.remember);showFeed();refresh();
  } catch {endSession("請重新登入。");}
})();
