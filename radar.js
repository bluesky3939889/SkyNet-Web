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
  const withinHour = row => Date.parse(row.occurred_at) >= Date.now() - 3600000;
  const ageBracket = row => [1, 5, 10, 30, 60].find(
    minutes => Date.now() - Date.parse(row.occurred_at) <= minutes * 60000
  ) || 60;
  const markerColors = {1:"#ff6674",5:"#ffab54",10:"#ffdf55",30:"#a5d86a",60:"#d0d0d0"};
  const mapChoice = $("radar-map-choice");
  const mapSearch = $("radar-map-search");
  const favoriteChoice = $("radar-map-favorites");
  let mapRows = [];
  mapSearch.addEventListener("input", render);
  mapChoice.addEventListener("change", () => {
    const row = mapRows.find(item => item.map_asset === mapChoice.value);
    if (row) {
      $("radar-map-menu").open = false;
      showMap(row);
    }
    else closeMap();
    render();
  });
  favoriteChoice.addEventListener("change", () => {
    const row = mapRows.find(item => item.map_asset === favoriteChoice.value);
    if (!row) return;
    $("radar-map-favorite-menu").open = false;
    mapSearch.value = "";
    showMap(row);
    render();
  });
  const modes = new Map([
    ["report", "雷達回報"], ["map", "地圖模式"], ["boss", "BOSS 偵測"],
    ["phase", "女皇憤怒事件"], ["banner", "橫幅位置推估"],
  ]);
  const readPreference = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const savePreference = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };
  const favoriteKey = "skynet-radar-map-favorites";
  const savedFavorites = readPreference(favoriteKey, []);
  const favorites = new Set(Array.isArray(savedFavorites) ? savedFavorites : []);
  const hiddenMapsKey = "skynet-radar-hidden-maps";
  const savedHiddenMaps = readPreference(hiddenMapsKey, []);
  const hiddenMapsInput = $("radar-hidden-maps");
  hiddenMapsInput.value = Array.isArray(savedHiddenMaps) ? savedHiddenMaps.join(",") : "";
  const mapNameKey = name => (name || "").trim().normalize("NFC").toLocaleLowerCase();
  let hiddenMaps = new Set(hiddenMapsInput.value.split(",").filter(Boolean).map(mapNameKey));
  $("radar-hidden-maps-form").addEventListener("submit", event => {
    event.preventDefault();
    const names = [...new Set(hiddenMapsInput.value.split(/[,，]+/).map(name => name.trim()).filter(Boolean))];
    hiddenMapsInput.value = names.join(",");
    hiddenMaps = new Set(names.map(mapNameKey));
    savePreference(hiddenMapsKey, names);
    const status = $("radar-hidden-maps-status");
    status.hidden = false;
    status.textContent = names.length ? `已隱藏 ${names.length} 張地圖。` : "已清除隱藏地圖設定。";
    render();
  });
  const mapNames = $("radar-map-names");
  const mapFollow = $("radar-map-follow");
  mapNames.checked = readPreference("skynet-radar-map-names", true);
  mapFollow.checked = readPreference("skynet-radar-map-follow", true);
  mapNames.addEventListener("change", () => {
    savePreference("skynet-radar-map-names", mapNames.checked);
    drawMap(false);
  });
  mapFollow.addEventListener("change", () => {
    savePreference("skynet-radar-map-follow", mapFollow.checked);
    render();
  });
  $("radar-map-favorite").addEventListener("click", () => {
    if (!selected) return;
    const name = selected.map_name || selected.map_asset;
    if (!favorites.delete(name)) favorites.add(name);
    savePreference(favoriteKey, [...favorites]);
    render();
  });
  $("radar-map-fit").addEventListener("click", () => { zoom = 1; drawMap(false); viewport.scrollTo(0,0); });
  canvas.addEventListener("dblclick", () => { if (mode === "map" && !selecting) $("radar-map-fit").click(); });
  canvas.addEventListener("wheel", event => {
    if (mode !== "map" || !image) return;
    event.preventDefault();
    zoom = Math.min(5, Math.max(1, zoom * (event.deltaY < 0 ? 1.2 : 1/1.2)));
    drawMap(false);
  }, {passive:false});
  let pan = null;
  canvas.addEventListener("pointerdown", event => {
    if (mode !== "map" || selecting || !image || !event.isPrimary || event.button !== 0) return;
    pan = [event.clientX, event.clientY, viewport.scrollLeft, viewport.scrollTop];
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (pan && event.isPrimary) viewport.scrollTo(pan[2]+pan[0]-event.clientX, pan[3]+pan[1]-event.clientY);
  });
  for (const event of ["pointerup","pointercancel","lostpointercapture"]) {
    canvas.addEventListener(event, () => { pan = null; });
  }
  const orderKey = "skynet-radar-mode-order";
  const savedOrder = readPreference(orderKey, []);
  const modeOrder = [...new Set([...(Array.isArray(savedOrder) ? savedOrder : []), ...modes.keys()])]
    .filter(id => modes.has(id));
  let mode = "report";
  const groupKey = "skynet-radar-group-overrides";
  const groupOverrides = new Map();
  const savedGroups = readPreference(groupKey, []);
  if (Array.isArray(savedGroups)) for (const entry of savedGroups) {
    if (Array.isArray(entry) && typeof entry[0] === "string" &&
        (entry[1] === null || Array.isArray(entry[1]))) groupOverrides.set(...entry);
  }
  const buttonFor = (label, action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  };
  function renderModes() {
    $("radar-heading").textContent = modes.get(mode);
    $("radar-kind").hidden = $("radar-kind-label").hidden = mode !== "map";
    $("radar-map-close").hidden = mode === "map";
    $("radar-columns").parentElement?.toggleAttribute("hidden", Boolean(modeColumns[mode]));
    $("radar-modes").replaceChildren(...modeOrder.map(id => {
      const button = buttonFor(modes.get(id), () => {
        mode = id;
        closeMap();
        $("radar-kind").value = "";
        renderModes();
        render();
      });
      button.setAttribute("aria-pressed", String(id === mode));
      return button;
    }));
    $("radar-mode-order").replaceChildren(...modeOrder.map((id, index) => {
      const row = document.createElement("div");
      row.className = "radar-order-row";
      const move = offset => {
        const target = index + offset;
        [modeOrder[index], modeOrder[target]] = [modeOrder[target], modeOrder[index]];
        savePreference(orderKey, modeOrder);
        renderModes();
      };
      const up = buttonFor("上移", () => move(-1));
      const down = buttonFor("下移", () => move(1));
      up.disabled = index === 0;
      down.disabled = index === modeOrder.length - 1;
      row.append(modes.get(id), up, down);
      return row;
    }));
  }
  function groupsFor(row) {
    const groups = (row.clan_groups || []).filter(group => !groupOverrides.has(group));
    const clan = row.clan_name?.toLocaleLowerCase();
    if (clan) for (const [group, clans] of groupOverrides) {
      if (clans?.some(name => name.toLocaleLowerCase() === clan)) groups.push(group);
    }
    return groups;
  }
  function editGroup(group) {
    $("radar-group-name").value = group;
    const clans = groupOverrides.get(group) ?? records
      .filter(row => row.clan_groups?.includes(group)).map(row => row.clan_name).filter(Boolean);
    $("radar-group-clans").value = [...new Set(clans)].join(",");
  }
  function saveGroup(remove) {
    const group = $("radar-group-name").value.trim();
    if (!group) return;
    const clans = [...new Set($("radar-group-clans").value.split(/[,，\r\n]+/).map(name => name.trim()).filter(Boolean))];
    groupOverrides.set(group, remove ? null : clans);
    savePreference(groupKey, [...groupOverrides]);
    if (remove && activeGroup === group) activeGroup = "";
    $("radar-group-status").textContent = remove ? "已移除群組。" : "已儲存到此瀏覽器。";
    render();
  }
  $("radar-group-form").addEventListener("submit", event => { event.preventDefault(); saveGroup(false); });
  $("radar-group-delete").addEventListener("click", () => saveGroup(true));
  const columns = [
    ["time", "回報時間", row => reportClock.format(new Date(row.occurred_at))],
    ["age", "多久前", row => {
      const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(row.occurred_at)) / 60000));
      if (minutes < 1) return "剛剛";
      if (minutes < 60) return `${minutes} 分前`;
      if (minutes < 1440) return `${Math.floor(minutes / 60)} 小時前`;
      return `${Math.floor(minutes / 1440)} 天前`;
    }],
    ["name", "角色／BOSS", row => row.name],
    ["nickname", "暱稱", row => row.nickname],
    ["clan", "血盟", row => row.clan_name],
    ["server", "伺服器", row => row.server_name],
    ["map", "地圖", row => row.map_name],
    ["location", "大概位置", row => row.location],
    ["route", "分區", row => row.route_title],
    ["groups", "群組", row => groupsFor(row).join("、")],
    ["kind", "類型", row => modes.get(row.kind)],
    ["coordinates", "座標", row => Number.isFinite(row.x) && Number.isFinite(row.y) ? `X ${row.x} / Y ${row.y}` : ""],
    ["action", "地圖操作", mapButton],
  ];
  const reportClock = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const eventTime = row => reportClock.format(new Date(row.occurred_at));
  const coordinates = values => Array.isArray(values) ? values.join(" / ") : "";
  const detailsFor = row => row.details || {};
  const modeColumns = {
    boss: [
      ["發現時間", eventTime], ["BOSS 中文名稱", row => row.name], ["伺服器", row => row.server_name],
      ["地圖", row => row.map_name], ["大概位置", row => row.location], ["出王時段", row => detailsFor(row).period],
      ["位置狀態", row => Number.isFinite(detailsFor(row).until) ? (Date.now()/1000 <= row.details.until ? "發現時位置" : "已過期") : ""],
      ["通報來源", row => detailsFor(row).reporters], ["地圖操作", mapButton],
    ],
    phase: [
      ["首次回報", eventTime], ["BOSS", row => row.name], ["階段", row => row.location],
      ["事件所在地圖", row => row.map_name], ["規則分區", row => row.route_title],
      ["來源數", row => detailsFor(row).count], ["通報來源", row => detailsFor(row).reporters],
      ["紀錄狀態", row => detailsFor(row).state],
    ],
    banner: [
      ["觀測時間", row => detailsFor(row).first_at ? reportClock.format(new Date(row.details.first_at*1000)) : eventTime(row)],
      ["BOSS", row => row.name], ["樓層", row => row.map_name],
      ["有效／收到（自身）", row => Number.isFinite(detailsFor(row).count)
        ? `${row.details.count}／${row.details.received}（自身 ${row.details.self_count}）` : ""],
      ["候選／參考中心", row => coordinates(detailsFor(row).center)],
      ["範圍", row => coordinates(detailsFor(row).bounds)],
      ["判斷", row => detailsFor(row).state || row.location],
      ["通報來源", row => detailsFor(row).reporters], ["參考區地圖", mapButton],
    ],
  };
  const columnStorageKey = "skynet-radar-hidden-columns";
  const hiddenColumns = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(columnStorageKey));
    if (Array.isArray(saved)) for (const key of saved) if (key !== "name") hiddenColumns.add(key);
  } catch {}
  for (const [key, title] of columns.filter(([key]) => key !== "name")) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !hiddenColumns.has(key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) hiddenColumns.delete(key);
      else hiddenColumns.add(key);
      try { localStorage.setItem(columnStorageKey, JSON.stringify([...hiddenColumns])); } catch {}
      render();
    });
    label.append(checkbox, title);
    $("radar-columns").append(label);
  }

  function reset() {
    mode = "report";
    $("radar-group-form").reset();
    $("radar-group-status").textContent = "";
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
    $("radar-feed").hidden = true;
  }

  function drawMap(center = true) {
    if (!image || !selected) return;
    const scale = Math.min(viewport.clientWidth / image.naturalWidth,
      viewport.clientHeight / image.naturalHeight) * zoom;
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    const x = selected.map_px * canvas.width, y = selected.map_py * canvas.height;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const region of selected.map_regions || []) {
      ctx.beginPath();
      region.points.forEach(([px, py], index) => {
        const point = [px * canvas.width, py * canvas.height];
        if (index === 0) ctx.moveTo(...point);
        else ctx.lineTo(...point);
      });
      ctx.closePath();
      ctx.fillStyle = "#5ce7cb22";
      ctx.strokeStyle = "#5ce7cb";
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      const [px, py] = region.points[0];
      ctx.font = "14px sans-serif";
      ctx.fillStyle = "#fff";
      ctx.fillText(region.name, px * canvas.width + 3, py * canvas.height + 15);
    }
    if (mode === "map") for (const row of mapRows) {
      if (row.map_asset !== selected.map_asset || !withinHour(row)) continue;
      const px = row.map_px * canvas.width, py = row.map_py * canvas.height;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = markerColors[ageBracket(row)];
      ctx.fill();
      if (mapNames.checked) {
        ctx.font = "14px sans-serif";
        ctx.strokeStyle = "#101820";
        ctx.lineWidth = 3;
        ctx.strokeText(row.nickname || row.name, px + 8, py - 6);
        ctx.fillText(row.nickname || row.name, px + 8, py - 6);
      }
    }
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
    zoom = 1;
    $("radar-map-title").textContent = row.map_name || "回報位置";
    $("radar-map-detail").textContent = [row.name, row.location, "載入地圖…"].filter(Boolean).join(" · ");
    $("radar-map").hidden = false;
    viewport.hidden = false;
    $("radar-map-controls").hidden = mode !== "map";
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
    records = records.filter(withinHour);
    if (selected && !withinHour(selected)) closeMap();
    const groupBar = $("radar-groups");
    const groups = [...new Set([...records.flatMap(groupsFor),
      ...[...groupOverrides].filter(([, clans]) => clans !== null).map(([name]) => name)])].sort();
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
        button.addEventListener("click", () => { activeGroup = group; editGroup(group); closeMap(); render(); });
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
    if (selected && hiddenMaps.has(mapNameKey(selected.map_name))) closeMap();
    const matching = records.filter(row => !hiddenMaps.has(mapNameKey(row.map_name)) &&
      (mode === "map" ? /^[a-f0-9]{64}$/.test(row.map_asset || "") &&
      [row.map_px,row.map_py].every(Number.isFinite) :
      mode === "phase" ? row.kind === "phase" || (row.kind === "boss" && ["快滿預告","滿階觸發","週期重置"].includes(row.location)) :
      row.kind === mode && !(mode === "boss" && ["快滿預告","滿階觸發","週期重置"].includes(row.location))) &&
      (!region.value || region.value === row.route_id) && (!kind || mode !== "map" || kind === row.kind) &&
      (!activeGroup || groupsFor(row).includes(activeGroup)) &&
      radarFilters.every(([id, field]) => !$(id).value || $(id).value === row[field]) &&
      (!search || [row.name, row.nickname].some(name => name?.toLocaleLowerCase().includes(search))));
    mapRows = mode === "map" ? matching : [];
    $("radar-map-picker").hidden = mode !== "map";
    $("radar-map-favorite-menu").hidden = mode !== "map";
    const maps = new Map(mapRows.map(row => [row.map_asset, row.map_name || "未命名地圖"]));
    const mapId = selected?.map_asset || "";
    const query = mapSearch.value.trim().toLocaleLowerCase();
    const results = [...maps].filter(([, name]) => name.toLocaleLowerCase().includes(query));
    if (results.length !== mapChoice.options.length - 1 ||
        results.some(([id, name], index) => mapChoice.options[index+1]?.value !== id ||
          mapChoice.options[index+1]?.textContent !== name)) {
      mapChoice.replaceChildren(new Option(results.length ? "請選擇地圖" : "沒有符合的地圖", ""),
        ...results.map(([id, name]) => new Option(name, id)));
    }
    mapChoice.value = results.some(([id]) => id === mapId) ? mapId : "";
    if (mode === "map" && selected && !maps.has(selected.map_asset)) closeMap();
    if (mode === "map" && !selected && mapFollow.checked && mapRows.length) {
      const row = mapRows.find(item => item.map_asset === mapChoice.value) || mapRows[0];
      mapChoice.value = row.map_asset;
      showMap(row);
    }
    const favoriteMaps = [...maps].filter(([id, name]) => favorites.has(name) || favorites.has(id));
    favoriteChoice.replaceChildren(new Option(favoriteMaps.length ? "請選擇最愛地圖" : "目前沒有可開啟的最愛地圖", ""),
      ...favoriteMaps.map(([id, name]) => new Option(name, id)));
    favoriteChoice.value = "";
    if (mode === "map") {
      $("radar-map").hidden = false;
      viewport.hidden = !selected;
      $("radar-map-controls").hidden = !selected;
      if (!selected) $("radar-map-detail").textContent = maps.size ? "請選擇地圖。" : "目前沒有可顯示的地圖。";
    }
    $("radar-map-favorite").disabled = !selected;
    $("radar-map-favorite").textContent = selected && favorites.has(selected.map_name || selected.map_asset)
      ? "移出最愛" : "加入最愛";
    if (mode === "map" && image) drawMap(false);
    const filtered = matching.filter(row => (!selected || mode !== "map" || row.map_asset === selected.map_asset) &&
      (!area || (row.map_asset === selected?.map_asset && Number.isFinite(row.map_px) && Number.isFinite(row.map_py) &&
        row.map_px >= area[0] && row.map_px <= area[2] && row.map_py >= area[1] && row.map_py <= area[3])));
    if (area) $("radar-area-status").textContent = `最近 100 筆中，框選範圍符合 ${filtered.length} 筆`;
    const visible = modeColumns[mode]?.map(([title, value]) => ["", title, value]) ??
      columns.filter(([key]) => !hiddenColumns.has(key) || (mode === "map" && key === "action"));
    $("radar-empty").hidden = filtered.length > 0;
    $("radar-head").replaceChildren(...visible.map(([, title]) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = title;
      return th;
    }));
    $("radar-rows").replaceChildren(...filtered.map(row => {
      const tr = document.createElement("tr");
      tr.dataset.age = ageBracket(row);
      for (const [key, title, valueFor] of visible) {
        const cell = document.createElement("td");
        cell.dataset.label = title;
        cell.dataset.field = key;
        const value = valueFor(row);
        if (typeof value === "object" && value) cell.append(value);
        else cell.textContent = value === "" || value == null ? "—" : String(value);
        tr.append(cell);
      }
      return tr;
    }));
  }

  function mapButton(row) {
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
        return button;
      }
    return null;
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
        select:"id,user_id,occurred_at,created_at,kind,name,route_id,route_title,map_name,server_name,location,x,y,map_asset,map_px,map_py,clan_name,clan_groups,nickname,map_regions,details",
        occurred_at:"gte."+new Date(Date.now()-3600000).toISOString(),
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
        const keyFor = row => row.details?.event_key
          ? JSON.stringify([row.kind,row.user_id,row.details.event_key]) : row.id;
        const combined = new Map(records.map(row => [keyFor(row),row]));
        for (const row of result) {
          const key = keyFor(row);
          const previous = combined.get(key);
          if (!previous || row.created_at > previous.created_at ||
              (row.created_at === previous.created_at && row.user_id > previous.user_id)) combined.set(key,row);
        }
        records = [...combined.values()].sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0,100);
      }
      render();
      $("radar-status").textContent = records.length ? "最後同步 " + clock.format(new Date()) : "尚無雷達回報。請確認 Client 的上傳設定。";
    } catch (error) {
      if (active !== session || epoch !== requestEpoch) return;
      if (error.status === 401) endSession("登入已失效，請重新登入。");
      else $("radar-status").textContent = [403,404].includes(error.status) ?
        "雷達資料表尚未就緒，請管理者執行 7.0.0 的 schema.sql。" : "雷達回報暫時無法更新。";
    } finally {
      if (active === session && epoch === requestEpoch) render();
      refresh.disabled = false;
      if (active && opened && !document.hidden) poll = setTimeout(refreshRadar,delay);
    }
  }

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
  window.addEventListener("resize", () => drawMap(false));
  function show() { opened = true; $("radar-feed").hidden = false; renderModes(); refreshRadar(); }

  return {show, reset};
})();
