"use strict";

window.skynetRadar = (() => {
  let records = [], after = null, poll = null, epoch = 0, opened = false;
  let image = null, selected = null, zoom = 1, imageRequest = 0;
  let download = null, objectUrl = null, area = null, start = null, selecting = false;
  const canvas = $("radar-canvas");
  const viewport = $("radar-map-scroll");

  function closeMap() {
    ++imageRequest;
    download?.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    download = objectUrl = null;
    clearArea();
    image = selected = null;
    canvas.width = canvas.height = 0;
    $("radar-map").hidden = true;
  }

  const radarFilters = [
    ["radar-clan", "clan_name", "全部血盟"],
    ["radar-server", "server_name", "全部伺服器"],
    ["radar-map-filter", "map_name", "全部地圖"],
  ];
  let activeGroup = "";

  function reset() {
    ++epoch;
    clearTimeout(poll);
    opened = false;
    records = [];
    after = null;
    closeMap();
    $("radar-rows").replaceChildren();
    $("radar-status").textContent = "";
    $("radar-region").replaceChildren(new Option("全部分區", ""));
    $("radar-kind").value = "";
    activeGroup = "";
    $("radar-groups").replaceChildren();
    $("radar-groups").hidden = true;
    $("radar-search").value = "";
    for (const [id, , label] of radarFilters) $(id).replaceChildren(new Option(label, ""));
    $("board-tabs").hidden = $("radar-feed").hidden = true;
    $("show-people").setAttribute("aria-pressed", "true");
    $("show-radar").setAttribute("aria-pressed", "false");
  }

  function drawMap(center = true) {
    if (!image || !selected) return;
    canvas.width = Math.max(1, Math.round(viewport.clientWidth * zoom));
    canvas.height = Math.max(1, Math.round(canvas.width * image.naturalHeight / image.naturalWidth));
    const ctx = canvas.getContext("2d");
    const x = selected.map_px * canvas.width, y = selected.map_py * canvas.height;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fillStyle = "#e33c4555";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = "#eb4552";
    ctx.lineWidth = 3;
    ctx.stroke();
    if (area) {
      const [left, top, right, bottom] = area;
      ctx.fillStyle = "#5ce7cb44";
      ctx.strokeStyle = "#5ce7cb";
      ctx.lineWidth = 2;
      ctx.fillRect(left * canvas.width, top * canvas.height, (right-left) * canvas.width, (bottom-top) * canvas.height);
      ctx.strokeRect(left * canvas.width, top * canvas.height, (right-left) * canvas.width, (bottom-top) * canvas.height);
    }
    if (center) viewport.scrollTo(x - viewport.clientWidth / 2, y - viewport.clientHeight / 2);
  }

  async function showMap(row) {
    const session = active;
    if (!session) return;
    closeMap();
    const requestId = ++imageRequest;
    image = null;
    canvas.width = canvas.height = 0;
    selected = row;
    zoom = 1.5;
    $("radar-map-title").textContent = row.map_name || "回報位置";
    $("radar-map-detail").textContent = [row.name, row.location, "載入地圖…"].filter(Boolean).join(" · ");
    $("radar-map").hidden = false;
    $("radar-map").scrollIntoView({block:"nearest"});
    const next = new Image();
    next.onload = () => {
      if (requestId !== imageRequest) return;
      image = next;
      $("radar-map-detail").textContent = [row.name, row.location, `X ${row.x} / Y ${row.y}`].filter(Boolean).join(" · ");
      drawMap();
    };
    next.onerror = () => {
      if (requestId === imageRequest) $("radar-map-detail").textContent = "無法顯示地圖底圖。";
    };
    const controller = new AbortController();
    download = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        const access = await token(session, Boolean(attempt));
        if (active !== session || requestId !== imageRequest) return;
        response = await fetch(session.url + "/storage/v1/object/authenticated/skynet-radar-maps/" + row.map_asset + ".webp", {
          headers:{apikey:session.key, Authorization:"Bearer " + access}, signal:controller.signal,
          redirect:"error", credentials:"omit", cache:"no-store"
        });
        if (response.status !== 401) break;
      }
      if (!response.ok) throw new Error("map unavailable");
      const blob = await response.blob();
      if (active !== session || requestId !== imageRequest) return;
      objectUrl = URL.createObjectURL(blob);
      next.src = objectUrl;
    } catch {
      if (active === session && requestId === imageRequest)
        $("radar-map-detail").textContent = "無法讀取私人底圖，請確認登入及 Storage 部署。";
    } finally {
      clearTimeout(timeout);
      if (download === controller) download = null;
    }
  }

  function clearArea() {
    area = start = null;
    selecting = false;
    canvas.classList.toggle("selecting", false);
    $("radar-select").setAttribute("aria-pressed", "false");
    $("radar-area-status").textContent = "";
  }

  function point(event) {
    const bounds = canvas.getBoundingClientRect();
    const clamp = value => Math.min(1, Math.max(0, value));
    return [clamp((event.clientX - bounds.left) / bounds.width), clamp((event.clientY - bounds.top) / bounds.height)];
  }

  function render() {
    const groupBar = $("radar-groups");
    const groups = [...new Set(records.flatMap(row => row.clan_groups || []))].sort();
    if (activeGroup && !groups.includes(activeGroup)) activeGroup = "";
    groupBar.hidden = !groups.length;
    const groupOptions = ["", ...groups];
    if (groupOptions.length !== groupBar.children.length ||
        groupOptions.some((group, index) => groupBar.children[index]?.value !== group)) {
      groupBar.replaceChildren(...groupOptions.map(group => {
        const button = document.createElement("button");
        button.type = "button";
        button.value = group;
        button.textContent = group || "全部群組";
        button.addEventListener("click", () => { activeGroup = group; closeMap(); render(); });
        return button;
      }));
    }
    for (const button of groupBar.children) button.setAttribute("aria-pressed", String(button.value === activeGroup));
    for (const [id, field, label] of radarFilters) {
      const select = $(id), previous = select.value;
      const values = [...new Set(records.map(row => row[field]).filter(Boolean))].sort();
      if (values.length !== select.options.length - 1 ||
          values.some((value, index) => select.options[index+1]?.value !== value)) {
        select.replaceChildren(new Option(label, ""), ...values.map(value => new Option(value, value)));
        if (values.includes(previous)) select.value = previous;
      }
    }
    const search = $("radar-search").value.trim().toLocaleLowerCase();
    const region = $("radar-region"), previous = region.value;
    const routes = new Map(records.map(row => [row.route_id, row.route_title]));
    if (routes.size !== region.options.length - 1 ||
        [...region.options].slice(1).some(option => routes.get(option.value) !== option.textContent)) {
      region.replaceChildren(new Option("全部分區", ""), ...[...routes].map(([id, name]) => new Option(name, id)));
      if (routes.has(previous)) region.value = previous;
    }
    const kind = $("radar-kind").value;
    const filtered = records.filter(row => (!region.value || region.value === row.route_id) && (!kind || kind === row.kind) &&
      (!activeGroup || row.clan_groups?.includes(activeGroup)) &&
      radarFilters.every(([id, field]) => !$(id).value || $(id).value === row[field]) &&
      (!search || row.name.toLocaleLowerCase().includes(search)) &&
      (!area || (row.map_asset === selected?.map_asset && Number.isFinite(row.map_px) && Number.isFinite(row.map_py) &&
        row.map_px >= area[0] && row.map_px <= area[2] && row.map_py >= area[1] && row.map_py <= area[3])));
    if (area) $("radar-area-status").textContent = `最近 100 筆中，框選範圍符合 ${filtered.length} 筆`;
    $("radar-rows").replaceChildren(...filtered.map(row => {
      const li = document.createElement("li"), name = document.createElement("strong");
      const badge = document.createElement("span"), info = document.createElement("small");
      name.textContent = row.name;
      badge.textContent = row.kind === "boss" ? "BOSS" : "回報";
      info.textContent = [row.route_title, row.clan_name, row.server_name, row.map_name, row.location,
        row.x !== null && row.y !== null ? `X ${row.x} / Y ${row.y}` : "",
        clock.format(new Date(row.occurred_at))].filter(Boolean).join(" · ");
      li.append(name, badge, info);
      if (/^[a-f0-9]{64}$/.test(row.map_asset || "") &&
          [row.map_px,row.map_py].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = "查看地圖";
        button.addEventListener("click", () => {
          if (area && image && row.map_asset === selected?.map_asset) {
            selected = row;
            $("radar-map-detail").textContent = [row.name, row.location, `X ${row.x} / Y ${row.y}`].filter(Boolean).join(" · ");
            drawMap();
          } else return showMap(row);
        });
        li.append(button);
      }
      return li;
    }));
  }

  async function refreshRadar() {
    clearTimeout(poll);
    const session = active;
    if (!session || !opened || document.hidden || $("radar-refresh").disabled) return;
    const requestEpoch = epoch;
    const refresh = $("radar-refresh");
    refresh.disabled = true;
    let delay = 5000;
    try {
      const query = new URLSearchParams({
        select:"id,user_id,occurred_at,created_at,kind,name,route_id,route_title,map_name,server_name,location,x,y,map_asset,map_px,map_py,clan_name,clan_groups",
        order:after ? "created_at.asc,id.asc,user_id.asc" : "created_at.desc,id.desc,user_id.desc", limit:"100"
      });
      if (after) query.set("or", `(created_at.gt.${after.created_at},and(created_at.eq.${after.created_at},id.gt.${after.id}),and(created_at.eq.${after.created_at},id.eq.${after.id},user_id.gt.${after.user_id}))`);
      let result;
      for (let attempt=0; attempt<2; ++attempt) {
        try {
          const access = await token(session,Boolean(attempt));
          const membership = await api(session,"/rest/v1/skynet_radar_members?select=user_id&limit=1",null,access);
          if (active !== session || epoch !== requestEpoch) return;
          if (!Array.isArray(membership) || !membership.some(member => member.user_id === session.owner)) {
            records = [];
            after = null;
            closeMap();
            render();
            $("radar-status").textContent = "此帳號尚未加入共享雷達，請聯絡管理員。";
            return;
          }
          result = await api(session,"/rest/v1/skynet_radar?" + query,null,access);
          break;
        }
        catch (error) { if (error.status !== 401 || attempt) throw error; }
      }
      if (active !== session || epoch !== requestEpoch) return;
      if (!Array.isArray(result) || result.some(row => !/^[a-f0-9-]{36}$/i.test(row.user_id) ||
          !/^[a-f0-9-]{36}$/i.test(row.id) || !Number.isFinite(Date.parse(row.created_at)) ||
          !Number.isFinite(Date.parse(row.occurred_at)))) throw new Error("invalid radar data");
      if (result.length) {
        const incremental = Boolean(after);
        after = incremental ? result.at(-1) : result[0];
        if (incremental && result.length === 100) delay = 250;
        const combined = new Map(records.map(row => [row.id,row]));
        for (const row of result) {
          const previous = combined.get(row.id);
          if (!previous || row.created_at > previous.created_at ||
              (row.created_at === previous.created_at && row.user_id > previous.user_id)) combined.set(row.id,row);
        }
        records = [...combined.values()].sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0,100);
        render();
      }
      $("radar-status").textContent = records.length ? "最後同步 " + clock.format(new Date()) : "尚無雷達回報。請確認 Client 的上傳設定。";
    } catch (error) {
      if (active !== session || epoch !== requestEpoch) return;
      if (error.status === 401) endSession("登入已失效，請重新登入。");
      else $("radar-status").textContent = [403,404].includes(error.status) ?
        "雷達資料表尚未就緒，請管理者執行 7.0.0 的 schema.sql。" : "雷達回報暫時無法更新。";
    } finally {
      refresh.disabled = false;
      if (active && opened && !document.hidden) poll = setTimeout(refreshRadar,delay);
    }
  }

  function switchBoard(radar) {
    opened = radar;
    $("feed").hidden = radar;
    $("radar-feed").hidden = !radar;
    $("show-people").setAttribute("aria-pressed", String(!radar));
    $("show-radar").setAttribute("aria-pressed", String(radar));
    clearTimeout(radar ? timer : poll);
    if (radar) refreshRadar();
    else refresh();
  }
  $("show-people").addEventListener("click", () => switchBoard(false));
  $("show-radar").addEventListener("click", () => switchBoard(true));
  $("radar-refresh").addEventListener("click", refreshRadar);
  $("radar-region").addEventListener("change", () => {closeMap(); render();});
  $("radar-kind").addEventListener("change", () => {closeMap(); render();});
  for (const [id] of radarFilters) $(id).addEventListener("change", () => {closeMap(); render();});
  $("radar-search").addEventListener("input", render);
  $("radar-map-close").addEventListener("click", () => {closeMap(); render();});
  $("radar-select").addEventListener("click", () => {
    if (!image) return;
    selecting = !selecting;
    canvas.classList.toggle("selecting", selecting);
    $("radar-select").setAttribute("aria-pressed", String(selecting));
    $("radar-area-status").textContent = selecting ? "在地圖上拖曳框選範圍。" : "";
    if (!selecting) render();
  });
  $("radar-clear-area").addEventListener("click", () => {clearArea(); drawMap(false); render();});
  canvas.addEventListener("pointerdown", event => {
    if (!selecting || !image || !event.isPrimary || event.button !== 0) return;
    start = point(event);
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointerup", event => {
    if (!start || !event.isPrimary) return;
    const [x, y] = point(event), [sx, sy] = start;
    start = null;
    if (Math.abs(x-sx)*canvas.width < 4 || Math.abs(y-sy)*canvas.height < 4) return;
    clearArea();
    area = [Math.min(x,sx), Math.min(y,sy), Math.max(x,sx), Math.max(y,sy)];
    drawMap(false);
    render();
  });
  canvas.addEventListener("pointercancel", () => {start = null;});
  $("radar-zoom-in").addEventListener("click", () => {zoom = Math.min(5,zoom + 0.5); drawMap();});
  $("radar-zoom-out").addEventListener("click", () => {zoom = Math.max(1,zoom - 0.5); drawMap();});
  $("radar-center").addEventListener("click", drawMap);
  document.addEventListener("visibilitychange", () => {
    clearTimeout(poll);
    if (!document.hidden) refreshRadar();
  });
  window.addEventListener("pagehide", () => clearTimeout(poll));
  window.addEventListener("pageshow", refreshRadar);
  function show() { $("board-tabs").hidden = false; }
  if (active) show();
  return {show, reset};
})();
