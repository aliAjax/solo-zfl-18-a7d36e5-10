// 版本兼容验算台：版本登记、组合验算、生命周期管理、导入导出
// 依赖 app.js 中的全局：state / saveState / renderAll / touch / deleteFromCollection / escapeHtml / builderKey

const wbEls = {
  gameSelect: document.querySelector("#wbGameSelect"),
  exportBtn: document.querySelector("#exportBtn"),
  importBtn: document.querySelector("#importBtn"),
  importFile: document.querySelector("#importFile"),
  importReport: document.querySelector("#importReport"),
  genBaseBtn: document.querySelector("#genBaseBtn"),
  versionList: document.querySelector("#versionList"),
  versionForm: document.querySelector("#versionForm"),
  versionFormTitle: document.querySelector("#versionFormTitle"),
  versionEditId: document.querySelector("#versionEditId"),
  versionKind: document.querySelector("#versionKind"),
  versionName: document.querySelector("#versionName"),
  versionMinDelta: document.querySelector("#versionMinDelta"),
  versionMaxDelta: document.querySelector("#versionMaxDelta"),
  versionDurationDelta: document.querySelector("#versionDurationDelta"),
  minDeltaLabel: document.querySelector("#minDeltaLabel"),
  maxDeltaLabel: document.querySelector("#maxDeltaLabel"),
  durationDeltaLabel: document.querySelector("#durationDeltaLabel"),
  versionRequires: document.querySelector("#versionRequires"),
  versionExcludes: document.querySelector("#versionExcludes"),
  versionEffects: document.querySelector("#versionEffects"),
  versionCancelEdit: document.querySelector("#versionCancelEdit"),
  comboForm: document.querySelector("#comboForm"),
  comboEditId: document.querySelector("#comboEditId"),
  comboName: document.querySelector("#comboName"),
  comboBase: document.querySelector("#comboBase"),
  comboExps: document.querySelector("#comboExps"),
  comboPlayers: document.querySelector("#comboPlayers"),
  comboVerdict: document.querySelector("#comboVerdict"),
  saveDraftBtn: document.querySelector("#saveDraftBtn"),
  publishBtn: document.querySelector("#publishBtn"),
  cancelComboEdit: document.querySelector("#cancelComboEdit"),
  comboStatusFilter: document.querySelector("#comboStatusFilter"),
  comboList: document.querySelector("#comboList")
};

// 组合编辑器状态：独立于主 state，刷新后从 localStorage 恢复
const builder = { editId: "", name: "", baseId: "", expIds: [], players: 4 };
// 版本表单的勾选状态（避免重渲染丢失）
const versionChecks = { requires: new Set(), excludes: new Set() };
const openHistory = new Set();
const openVersionHistory = new Set();

const STATUS_LABEL = { draft: "草稿", published: "已发布", archived: "已归档" };

function nowIso() {
  return new Date().toISOString();
}

function getGameVersions(gameId) {
  return state.versions.filter((v) => v.gameId === gameId);
}

function getVersion(id) {
  return state.versions.find((v) => v.id === id);
}

function versionLabel(v) {
  return v ? v.name : "（已删除）";
}

// ---------- 验算引擎 ----------
function findCycle(versions) {
  const byId = new Map(versions.map((v) => [v.id, v]));
  const color = new Map(versions.map((v) => [v.id, 0])); // 0白 1灰 2黑
  const stack = [];
  let cycle = null;
  function dfs(v) {
    if (cycle) return;
    color.set(v.id, 1);
    stack.push(v);
    for (const reqId of v.requires || []) {
      const target = byId.get(reqId);
      if (!target) continue;
      if (color.get(target.id) === 1) {
        cycle = [...stack.slice(stack.findIndex((x) => x.id === target.id)), target];
        return;
      }
      if (color.get(target.id) === 0) dfs(target);
      if (cycle) return;
    }
    stack.pop();
    color.set(v.id, 2);
  }
  for (const v of versions) {
    if (color.get(v.id) === 0) dfs(v);
    if (cycle) break;
  }
  return cycle;
}

function validateCombo(gameId, baseId, expIds, players, pool) {
  const issues = [];
  const versions = pool || getGameVersions(gameId);
  const byId = new Map(versions.map((v) => [v.id, v]));
  const base = byId.get(baseId);
  if (!base || base.kind !== "base") {
    issues.push({ type: "base", msg: "缺少有效的基础版本，请先在版本登记中创建。" });
    return { issues, effMin: 0, effMax: 0, effDuration: 0 };
  }

  // 重复扩展
  const seenIds = new Set();
  const seenNames = new Set();
  const selected = [];
  for (const id of expIds) {
    const v = byId.get(id);
    if (!v) {
      issues.push({ type: "missing", msg: `扩展引用失效：${id}` });
      continue;
    }
    if (seenIds.has(id) || seenNames.has(v.name)) {
      issues.push({ type: "duplicate", msg: `重复扩展：「${v.name}」被加入多次` });
      continue;
    }
    seenIds.add(id);
    seenNames.add(v.name);
    selected.push(v);
  }
  const selectedIds = new Set(selected.map((v) => v.id));

  // 缺少依赖
  for (const v of selected) {
    for (const reqId of v.requires || []) {
      if (reqId === baseId) continue;
      const target = byId.get(reqId);
      if (!target) issues.push({ type: "missing-dep", msg: `缺少依赖：「${v.name}」需要的组件已失效` });
      else if (!selectedIds.has(reqId)) issues.push({ type: "missing-dep", msg: `缺少依赖：「${v.name}」需要先加入「${target.name}」` });
    }
  }

  // 循环依赖
  const cycle = findCycle([base, ...selected]);
  if (cycle) issues.push({ type: "cycle", msg: `循环依赖：${cycle.map((v) => v.name).join(" → ")}` });

  // 互斥冲突：双方任一声明即阻断（基础版本的声明同样生效）
  const allSelected = [base, ...selected];
  const seenPairs = new Set();
  for (const v of allSelected) {
    for (const exId of v.excludes || []) {
      const other = allSelected.find((x) => x.id === exId);
      if (!other) continue;
      const pairKey = [v.id, exId].sort().join("|");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      issues.push({ type: "conflict", msg: `互斥冲突：「${v.name}」与「${other.name}」不能同局` });
    }
  }

  // 效果冲突：同一效果标签被多个版本修改
  const tagOwners = new Map();
  for (const v of [base, ...selected]) {
    for (const eff of v.effects || []) {
      if (!tagOwners.has(eff.tag)) tagOwners.set(eff.tag, new Set());
      tagOwners.get(eff.tag).add(v.name);
    }
  }
  for (const [tag, owners] of tagOwners) {
    if (owners.size > 1) issues.push({ type: "effect", msg: `效果冲突：标签「${tag}」被 ${[...owners].join("、")} 同时修改` });
  }

  // 人数时长修正
  const effMin = Number(base.minDelta) + selected.reduce((s, v) => s + (Number(v.minDelta) || 0), 0);
  const effMax = Number(base.maxDelta) + selected.reduce((s, v) => s + (Number(v.maxDelta) || 0), 0);
  const effDuration = Number(base.durationDelta) + selected.reduce((s, v) => s + (Number(v.durationDelta) || 0), 0);
  if (players < effMin || players > effMax) {
    issues.push({ type: "players", msg: `人数 ${players} 超出该组合允许范围 ${effMin}-${effMax} 人` });
  }

  return { issues, effMin, effMax, effDuration };
}

function comboSignature(parts) {
  return `${parts.gameId}|${parts.baseVersionId}|${[...(parts.expansionIds || [])].sort().join(",")}|${parts.players}`;
}

function comboSnapshot(combo) {
  return {
    name: combo.name,
    baseVersionId: combo.baseVersionId,
    expansionIds: [...combo.expansionIds],
    players: combo.players
  };
}

// ---------- 版本登记 ----------
function parseEffects(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.search(/[:：]/);
      if (idx === -1) return { tag: "效果", text: line };
      return { tag: line.slice(0, idx).trim(), text: line.slice(idx + 1).trim() };
    });
}

function effectsToText(effects) {
  return (effects || []).map((e) => `${e.tag}: ${e.text}`).join("\n");
}

function resetVersionForm() {
  wbEls.versionEditId.value = "";
  wbEls.versionFormTitle.textContent = "登记新版本";
  wbEls.versionForm.reset();
  wbEls.versionKind.value = "expansion";
  versionChecks.requires = new Set();
  versionChecks.excludes = new Set();
  wbEls.versionCancelEdit.hidden = true;
  updateKindLabels();
}

function updateKindLabels() {
  const isBase = wbEls.versionKind.value === "base";
  wbEls.minDeltaLabel.textContent = isBase ? "最少人数" : "人数下限修正";
  wbEls.maxDeltaLabel.textContent = isBase ? "最多人数" : "人数上限修正";
  wbEls.durationDeltaLabel.textContent = isBase ? "时长（分钟）" : "时长修正（分钟）";
  if (isBase && wbEls.versionEditId.value === "") {
    const game = state.games.find((g) => g.id === state.ui.wbGameId);
    if (game) {
      wbEls.versionMinDelta.value = game.minPlayers;
      wbEls.versionMaxDelta.value = game.maxPlayers;
      wbEls.versionDurationDelta.value = game.duration;
    }
  }
}

function saveVersion(event) {
  event.preventDefault();
  const gameId = state.ui.wbGameId;
  if (!gameId) return;
  const editId = wbEls.versionEditId.value;
  const fields = {
    gameId,
    kind: wbEls.versionKind.value,
    name: wbEls.versionName.value.trim(),
    requires: getGameVersions(gameId).filter((v) => versionChecks.requires.has(v.id)).map((v) => v.id),
    excludes: getGameVersions(gameId).filter((v) => versionChecks.excludes.has(v.id)).map((v) => v.id),
    minDelta: Number(wbEls.versionMinDelta.value),
    maxDelta: Number(wbEls.versionMaxDelta.value),
    durationDelta: Number(wbEls.versionDurationDelta.value),
    effects: parseEffects(wbEls.versionEffects.value)
  };
  if (!fields.name) return;
  // 不允许自己依赖/互斥自己
  fields.requires = fields.requires.filter((id) => id !== editId);
  fields.excludes = fields.excludes.filter((id) => id !== editId);

  if (editId) {
    const version = getVersion(editId);
    if (!version) return;
    version.history = version.history || [];
    version.history.push({
      rev: version.rev,
      snapshot: {
        kind: version.kind,
        name: version.name,
        requires: [...version.requires],
        excludes: [...version.excludes],
        minDelta: version.minDelta,
        maxDelta: version.maxDelta,
        durationDelta: version.durationDelta,
        effects: structuredClone(version.effects || [])
      },
      note: "编辑版本",
      at: nowIso()
    });
    Object.assign(version, fields);
    touch(version);
    // 引用该版本的组合标记为待复核，其局次随之显示受影响
    for (const combo of state.combos) {
      if (combo.gameId === gameId && (combo.baseVersionId === editId || combo.expansionIds.includes(editId))) {
        combo.versionStale = true;
        touch(combo);
      }
    }
  } else {
    state.versions.push(touch({ id: crypto.randomUUID(), history: [], ...fields }));
  }
  resetVersionForm();
  renderAll();
}

function editVersion(id) {
  const v = getVersion(id);
  if (!v) return;
  wbEls.versionEditId.value = v.id;
  wbEls.versionFormTitle.textContent = `编辑版本：${v.name}`;
  wbEls.versionKind.value = v.kind;
  wbEls.versionName.value = v.name;
  wbEls.versionMinDelta.value = v.minDelta;
  wbEls.versionMaxDelta.value = v.maxDelta;
  wbEls.versionDurationDelta.value = v.durationDelta;
  wbEls.versionEffects.value = effectsToText(v.effects);
  versionChecks.requires = new Set(v.requires || []);
  versionChecks.excludes = new Set(v.excludes || []);
  wbEls.versionCancelEdit.hidden = false;
  updateKindLabels();
  renderAll();
}

function renderVersionPanel() {
  const gameId = state.ui.wbGameId;
  const versions = getGameVersions(gameId);
  const editingId = wbEls.versionEditId.value;
  wbEls.genBaseBtn.hidden = versions.some((v) => v.kind === "base") || !gameId;

  wbEls.versionList.innerHTML =
    versions
      .map((v) => {
        const reqs = (v.requires || []).map((id) => versionLabel(getVersion(id))).join("、");
        const excls = (v.excludes || []).map((id) => versionLabel(getVersion(id))).join("、");
        const historyHtml = openVersionHistory.has(v.id)
          ? `<ul class="history-list">${(v.history || [])
              .map((h) => `<li>修订前「${escapeHtml(h.snapshot.name)}」 · ${escapeHtml(h.note)} · ${h.at.slice(0, 10)}</li>`)
              .join("")}</ul>`
          : "";
        return `
        <div class="version-card" data-version-id="${v.id}">
          <div class="version-head">
            <span class="pill ${v.kind === "base" ? "heavy" : ""}">${v.kind === "base" ? "基础" : "扩展"}</span>
            <strong>${escapeHtml(v.name)}</strong>
            <span class="rev-badge">v${(v.history || []).length + 1}</span>
          </div>
          <div class="version-meta">
            <span>${v.kind === "base" ? `${v.minDelta}-${v.maxDelta}人 · ${v.durationDelta}分钟` : `人数${fmtDelta(v.minDelta)}/${fmtDelta(v.maxDelta)} · ${fmtDelta(v.durationDelta)}分钟`}</span>
            ${reqs ? `<span>依赖：${escapeHtml(reqs)}</span>` : ""}
            ${excls ? `<span>互斥：${escapeHtml(excls)}</span>` : ""}
            ${(v.effects || []).map((e) => `<span>效果[${escapeHtml(e.tag)}]：${escapeHtml(e.text)}</span>`).join("")}
          </div>
          <div class="card-actions">
            <button type="button" data-version-edit="${v.id}">编辑</button>
            <button type="button" data-version-history="${v.id}">历史(${(v.history || []).length})</button>
          </div>
          ${historyHtml}
        </div>`;
      })
      .join("") || `<p class="empty">还没有登记版本，先在下方添加。</p>`;

  // 依赖 / 互斥 checkbox（不能选自己）
  const options = versions
    .filter((v) => v.id !== editingId)
    .map(
      (v) => `
      <label class="check-item">
        <input type="checkbox" data-req-id="${v.id}" ${versionChecks.requires.has(v.id) ? "checked" : ""} /> ${escapeHtml(v.name)}
      </label>`
    )
    .join("");
  wbEls.versionRequires.innerHTML = options || `<span class="empty">暂无其他版本</span>`;
  wbEls.versionExcludes.innerHTML = versions
    .filter((v) => v.id !== editingId)
    .map(
      (v) => `
      <label class="check-item">
        <input type="checkbox" data-excl-id="${v.id}" ${versionChecks.excludes.has(v.id) ? "checked" : ""} /> ${escapeHtml(v.name)}
      </label>`
    )
    .join("") || `<span class="empty">暂无其他版本</span>`;
}

function fmtDelta(n) {
  const num = Number(n) || 0;
  return num > 0 ? `+${num}` : String(num);
}

// ---------- 组合验算（编辑器） ----------
function persistBuilder() {
  localStorage.setItem(
    builderKey,
    JSON.stringify({ gameId: state.ui.wbGameId, editId: builder.editId, name: builder.name, baseId: builder.baseId, expIds: builder.expIds, players: builder.players })
  );
}

function restoreBuilder() {
  try {
    const saved = JSON.parse(localStorage.getItem(builderKey) || "null");
    if (!saved) return;
    if (saved.gameId && saved.gameId !== state.ui.wbGameId && state.games.some((g) => g.id === saved.gameId)) {
      state.ui.wbGameId = saved.gameId;
    }
    if (saved.gameId === state.ui.wbGameId) {
      builder.editId = saved.editId || "";
      builder.name = saved.name || "";
      builder.baseId = saved.baseId || "";
      builder.expIds = Array.isArray(saved.expIds) ? saved.expIds : [];
      builder.players = Number(saved.players) || 4;
    }
  } catch {
    /* 忽略损坏的草稿 */
  }
}

function resetBuilder() {
  builder.editId = "";
  builder.name = "";
  builder.baseId = "";
  builder.expIds = [];
  builder.players = 4;
  persistBuilder();
}

function renderBuilder() {
  const gameId = state.ui.wbGameId;
  const versions = getGameVersions(gameId);
  const bases = versions.filter((v) => v.kind === "base");
  const exps = versions.filter((v) => v.kind === "expansion");

  wbEls.comboEditId.value = builder.editId;
  wbEls.comboName.value = builder.name;
  wbEls.comboPlayers.value = builder.players;
  wbEls.comboBase.innerHTML =
    bases.map((v) => `<option value="${v.id}" ${v.id === builder.baseId ? "selected" : ""}>${escapeHtml(v.name)}</option>`).join("") ||
    `<option value="">（先登记基础版本）</option>`;
  if (!builder.baseId && bases[0]) builder.baseId = bases[0].id;
  wbEls.comboBase.value = builder.baseId;

  wbEls.comboExps.innerHTML =
    exps
      .map(
        (v) => `
        <label class="check-item">
          <input type="checkbox" data-exp-id="${v.id}" ${builder.expIds.includes(v.id) ? "checked" : ""} /> ${escapeHtml(v.name)}
        </label>`
      )
      .join("") || `<span class="empty">暂无扩展</span>`;

  const editing = builder.editId ? state.combos.find((c) => c.id === builder.editId) : null;
  wbEls.saveDraftBtn.textContent = editing ? "保存修订" : "存草稿";
  wbEls.publishBtn.hidden = Boolean(editing && editing.status !== "draft");
  wbEls.cancelComboEdit.hidden = !editing;

  renderVerdict();
}

function renderVerdict() {
  const gameId = state.ui.wbGameId;
  const { issues, effMin, effMax, effDuration } = validateCombo(gameId, builder.baseId, builder.expIds, builder.players);
  const hasBase = getGameVersions(gameId).some((v) => v.kind === "base");
  if (issues.length) {
    wbEls.comboVerdict.className = "verdict bad";
    wbEls.comboVerdict.innerHTML = `<strong>不可发布，发现 ${issues.length} 个问题：</strong><ul>${issues
      .map((i) => `<li>${escapeHtml(i.msg)}</li>`)
      .join("")}</ul>`;
  } else {
    wbEls.comboVerdict.className = "verdict ok";
    wbEls.comboVerdict.innerHTML = `<strong>✓ 可玩</strong>：有效范围 ${effMin}-${effMax} 人 · 约 ${effDuration} 分钟`;
  }
  wbEls.publishBtn.disabled = issues.length > 0 || !hasBase;
  wbEls.saveDraftBtn.disabled = !hasBase;
}

function readBuilderFromDom() {
  builder.name = wbEls.comboName.value.trim();
  builder.baseId = wbEls.comboBase.value;
  builder.players = Number(wbEls.comboPlayers.value) || 0;
  builder.expIds = [...wbEls.comboExps.querySelectorAll("[data-exp-id]:checked")].map((el) => el.dataset.expId);
}

function saveCombo(asPublish) {
  readBuilderFromDom();
  const gameId = state.ui.wbGameId;
  if (!builder.name) {
    wbEls.comboName.focus();
    return;
  }
  const { issues } = validateCombo(gameId, builder.baseId, builder.expIds, builder.players);
  if (asPublish && issues.length) {
    renderVerdict(); // 拦住：问题已在验算区列出
    return;
  }
  const sig = comboSignature({ gameId, baseVersionId: builder.baseId, expansionIds: builder.expIds, players: builder.players });
  const dup = state.combos.find((c) => c.id !== builder.editId && comboSignature(c) === sig);
  if (dup) {
    wbEls.comboVerdict.className = "verdict bad";
    wbEls.comboVerdict.innerHTML = `<strong>重复组合：</strong>与已有组合「${escapeHtml(dup.name)}」内容完全相同，已拦住。`;
    return;
  }

  if (builder.editId) {
    const combo = state.combos.find((c) => c.id === builder.editId);
    if (!combo) return;
    const note =
      combo.baseVersionId !== builder.baseId
        ? `更换基础版本：${versionLabel(getVersion(combo.baseVersionId))} → ${versionLabel(getVersion(builder.baseId))}`
        : "修改组合内容";
    combo.history.push({ revision: combo.revision, snapshot: comboSnapshot(combo), note, at: nowIso() });
    combo.name = builder.name;
    combo.baseVersionId = builder.baseId;
    combo.expansionIds = [...builder.expIds];
    combo.players = builder.players;
    combo.revision += 1;
    combo.versionStale = false;
    if (asPublish) combo.status = "published";
    touch(combo);
  } else {
    state.combos.unshift(
      touch({
        id: crypto.randomUUID(),
        gameId,
        name: builder.name,
        baseVersionId: builder.baseId,
        expansionIds: [...builder.expIds],
        players: builder.players,
        status: asPublish ? "published" : "draft",
        revision: 1,
        versionStale: false,
        history: [],
        createdAt: nowIso()
      })
    );
  }
  resetBuilder();
  renderAll();
}

function editCombo(id) {
  const combo = state.combos.find((c) => c.id === id);
  if (!combo) return;
  builder.editId = combo.id;
  builder.name = combo.name;
  builder.baseId = combo.baseVersionId;
  builder.expIds = [...combo.expansionIds];
  builder.players = combo.players;
  persistBuilder();
  renderAll();
}

// ---------- 组合生命周期 ----------
function comboAction(id, action) {
  const combo = state.combos.find((c) => c.id === id);
  if (!combo) return;
  if (action === "publish") {
    const { issues } = validateCombo(combo.gameId, combo.baseVersionId, combo.expansionIds, combo.players);
    if (issues.length) return; // 拦住
    combo.history.push({ revision: combo.revision, note: "发布", at: nowIso() });
    combo.status = "published";
    combo.versionStale = false;
    touch(combo);
  } else if (action === "archive") {
    combo.history.push({ revision: combo.revision, note: "归档", at: nowIso() });
    combo.status = "archived";
    touch(combo);
  } else if (action === "restore") {
    combo.history.push({ revision: combo.revision, note: "恢复为草稿", at: nowIso() });
    combo.status = "draft";
    touch(combo);
  } else if (action === "undo") {
    const last = [...combo.history].reverse().find((h) => h.snapshot);
    if (!last) return;
    combo.history.push({ revision: combo.revision, snapshot: comboSnapshot(combo), note: `撤销：回到修订 ${last.revision} 的内容`, at: nowIso() });
    Object.assign(combo, structuredClone(last.snapshot));
    combo.revision += 1;
    combo.versionStale = false;
    touch(combo);
  } else if (action === "session") {
    if (combo.status !== "published") return;
    state.sessions.push(
      touch({ id: crypto.randomUUID(), comboId: combo.id, comboRevision: combo.revision, playedAt: new Date().toISOString().slice(0, 10), note: "" })
    );
  } else if (action === "delete") {
    for (const s of state.sessions.filter((s) => s.comboId === id)) deleteFromCollection("sessions", s.id);
    deleteFromCollection("combos", id);
  }
  renderAll();
}

function renderComboList() {
  const gameId = state.ui.wbGameId;
  const filter = wbEls.comboStatusFilter.value;
  const combos = state.combos.filter((c) => c.gameId === gameId && (filter === "all" || c.status === filter));
  wbEls.comboList.innerHTML =
    combos
      .map((combo) => {
        const { issues, effMin, effMax, effDuration } = validateCombo(combo.gameId, combo.baseVersionId, combo.expansionIds, combo.players);
        const sessions = state.sessions.filter((s) => s.comboId === combo.id);
        const expNames = combo.expansionIds.map((id) => versionLabel(getVersion(id))).join("、");
        const canUndo = combo.history.some((h) => h.snapshot);
        const historyHtml = openHistory.has(combo.id)
          ? `<ul class="history-list">${combo.history
              .map((h) => `<li>修订 ${h.revision} · ${escapeHtml(h.note)} · ${h.at.slice(0, 10)}</li>`)
              .join("")}</ul>`
          : "";
        return `
        <div class="combo-card ${combo.status}" data-combo-id="${combo.id}">
          <div class="version-head">
            <span class="status-pill ${combo.status}">${STATUS_LABEL[combo.status]}</span>
            <strong>${escapeHtml(combo.name)}</strong>
            <span class="rev-badge">修订 ${combo.revision}</span>
            ${combo.versionStale ? `<span class="stale-badge">版本已变更</span>` : ""}
          </div>
          <div class="version-meta">
            <span>基础：${escapeHtml(versionLabel(getVersion(combo.baseVersionId)))}</span>
            <span>扩展：${escapeHtml(expNames || "无")}</span>
            <span>${combo.players} 人 · 有效 ${effMin}-${effMax} 人 · 约 ${effDuration} 分钟</span>
          </div>
          ${
            issues.length
              ? `<div class="verdict bad slim"><strong>当前不可玩：</strong><ul>${issues.map((i) => `<li>${escapeHtml(i.msg)}</li>`).join("")}</ul></div>`
              : ""
          }
          ${
            sessions.length
              ? `<div class="session-list"><span class="field-label">局次：</span>${sessions
                  .map(
                    (s) =>
                      `<span class="pill ${s.comboRevision < combo.revision || combo.versionStale ? "affected" : ""}">${s.playedAt}${
                        s.comboRevision < combo.revision || combo.versionStale ? " · 受影响" : ""
                      }</span>`
                  )
                  .join("")}</div>`
              : ""
          }
          <div class="card-actions">
            <button type="button" data-combo-action="edit" data-combo-id="${combo.id}">编辑</button>
            ${combo.status === "draft" ? `<button type="button" data-combo-action="publish" data-combo-id="${combo.id}">发布</button>` : ""}
            ${combo.status === "published" ? `<button type="button" data-combo-action="session" data-combo-id="${combo.id}">记录局次</button>` : ""}
            ${combo.status === "published" ? `<button type="button" data-combo-action="archive" data-combo-id="${combo.id}">归档</button>` : ""}
            ${combo.status === "archived" ? `<button type="button" data-combo-action="restore" data-combo-id="${combo.id}">恢复草稿</button>` : ""}
            ${canUndo ? `<button type="button" data-combo-action="undo" data-combo-id="${combo.id}">撤销</button>` : ""}
            <button type="button" data-combo-action="history" data-combo-id="${combo.id}">历史(${combo.history.length})</button>
            ${combo.status !== "published" ? `<button type="button" data-combo-action="delete" data-combo-id="${combo.id}">删除</button>` : ""}
          </div>
          ${historyHtml}
        </div>`;
      })
      .join("") || `<p class="empty">暂无组合，在中间验算并保存。</p>`;
}

// ---------- 导入导出 ----------
function versionFingerprint(v) {
  return JSON.stringify({
    gameId: v.gameId,
    kind: v.kind,
    name: v.name,
    requires: [...(v.requires || [])].sort(),
    excludes: [...(v.excludes || [])].sort(),
    minDelta: Number(v.minDelta) || 0,
    maxDelta: Number(v.maxDelta) || 0,
    durationDelta: Number(v.durationDelta) || 0,
    effects: v.effects || []
  });
}

function exportData() {
  const payload = {
    type: "zfl18-workbench",
    exportedAt: nowIso(),
    games: state.games,
    versions: state.versions,
    combos: state.combos,
    sessions: state.sessions
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `boardgame-workbench-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function validateImport(data) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["文件不是有效的 JSON 对象"];
  const games = Array.isArray(data.games) ? data.games : [];
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const combos = Array.isArray(data.combos) ? data.combos : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  if (!games.length && !versions.length && !combos.length && !sessions.length) return ["文件中没有可导入的数据"];

  const gameIds = new Set([...state.games.map((g) => g.id), ...games.map((g) => g.id)]);
  const versionIds = new Set([...state.versions.map((v) => v.id), ...versions.map((v) => v.id)]);
  const comboIds = new Set([...state.combos.map((c) => c.id), ...combos.map((c) => c.id)]);

  // 失效引用 / 归属不完整
  for (const v of versions) {
    if (!v.id || !v.name) errors.push(`失效引用：存在缺少 id 或名称的版本`);
    if (v.kind !== "base" && v.kind !== "expansion") errors.push(`失效引用：版本「${v.name}」类型缺失或非法`);
    if (!v.gameId || !gameIds.has(v.gameId)) errors.push(`失效引用：版本「${v.name}」缺少归属桌游或所属桌游不存在`);
    for (const ref of [...(v.requires || []), ...(v.excludes || [])]) {
      if (!versionIds.has(ref)) errors.push(`失效引用：版本「${v.name}」的依赖/互斥指向不存在的组件 ${ref}`);
    }
  }
  for (const c of combos) {
    if (!gameIds.has(c.gameId)) errors.push(`失效引用：组合「${c.name}」所属的桌游不存在`);
    if (!versionIds.has(c.baseVersionId)) errors.push(`失效引用：组合「${c.name}」的基础版本不存在`);
    for (const eid of c.expansionIds || []) {
      if (!versionIds.has(eid)) errors.push(`失效引用：组合「${c.name}」的扩展 ${eid} 不存在`);
    }
  }
  for (const s of sessions) {
    if (!comboIds.has(s.comboId)) errors.push(`失效引用：局次 ${s.playedAt || ""} 指向不存在的组合`);
  }

  // 版本冲突：同 id 内容不一致，或同游戏同类型同名不同 id
  for (const g of games) {
    const local = state.games.find((x) => x.id === g.id);
    if (local && local.name !== g.name) errors.push(`版本冲突：桌游「${g.name}」与本地同 ID 桌游不一致`);
  }
  for (const v of versions) {
    const local = state.versions.find((x) => x.id === v.id);
    if (local && versionFingerprint(local) !== versionFingerprint(v)) {
      errors.push(`版本冲突：「${v.name}」与本地同 ID 版本内容不一致`);
    }
    const sameName = state.versions.find((x) => x.id !== v.id && x.gameId === v.gameId && x.kind === v.kind && x.name === v.name);
    if (sameName) errors.push(`版本冲突：「${v.name}」与本地已有${v.kind === "base" ? "基础版本" : "扩展"}重名`);
  }

  // 缺组件：组合内扩展的依赖必须也在组合中
  const mergedVersions = new Map([...state.versions, ...versions].map((v) => [v.id, v]));
  for (const c of combos) {
    const selected = new Set([c.baseVersionId, ...(c.expansionIds || [])]);
    for (const eid of c.expansionIds || []) {
      const v = mergedVersions.get(eid);
      if (!v) continue;
      for (const req of v.requires || []) {
        if (!selected.has(req)) {
          errors.push(`缺组件：组合「${c.name}」中「${v.name}」需要「${mergedVersions.get(req)?.name || req}」`);
        }
      }
    }
  }

  // 组合语义无效：对导入组合跑完整验算（重复扩展/互斥/效果冲突/循环/人数范围），
  // 任何状态（包括已发布）的组合语义无效都拒绝整份数据
  const mergedPool = [...mergedVersions.values()];
  for (const c of combos) {
    if (!c.gameId || !gameIds.has(c.gameId)) continue; // 引用错误已在上面记录
    if (!c.baseVersionId || !versionIds.has(c.baseVersionId)) continue;
    const pool = mergedPool.filter((v) => v.gameId === c.gameId);
    const { issues } = validateCombo(c.gameId, c.baseVersionId, c.expansionIds || [], Number(c.players) || 0, pool);
    for (const issue of issues) errors.push(`组合语义无效：「${c.name}」${issue.msg}`);
  }

  // 重复组合：同 id 同内容视为已存在跳过；同 id 不同内容为冲突；签名重复为重复组合
  const comboFingerprint = (c) =>
    JSON.stringify({
      gameId: c.gameId,
      name: c.name,
      baseVersionId: c.baseVersionId,
      expansionIds: [...(c.expansionIds || [])].sort(),
      players: Number(c.players),
      status: c.status
    });
  const existingSigs = new Set(state.combos.map((c) => comboSignature(c)));
  const fileSigs = new Set();
  for (const c of combos) {
    const local = state.combos.find((x) => x.id === c.id);
    if (local) {
      if (comboFingerprint(local) !== comboFingerprint(c)) errors.push(`版本冲突：组合「${c.name}」与本地同 ID 组合内容不一致`);
      continue;
    }
    const sig = comboSignature(c);
    if (existingSigs.has(sig)) errors.push(`重复组合：「${c.name}」与现有组合完全相同`);
    else if (fileSigs.has(sig)) errors.push(`重复组合：文件内存在与「${c.name}」相同的组合`);
    fileSigs.add(sig);
  }

  return errors;
}

function applyImport(data) {
  const backup = JSON.stringify(state);
  try {
    let added = 0;
    const mergeIn = (collection, items) => {
      for (const item of items) {
        if (state[collection].some((x) => x.id === item.id)) continue; // 已存在且一致（冲突已在校验阶段拦截）
        state[collection].push(touch(structuredClone(item)));
        added += 1;
      }
    };
    mergeIn("games", data.games || []);
    mergeIn("versions", data.versions || []);
    mergeIn("combos", data.combos || []);
    mergeIn("sessions", data.sessions || []);
    saveState();
    renderAll();
    showImportReport("ok", `导入成功：新增 ${added} 条记录，原有数据未受影响。`);
  } catch (err) {
    state = JSON.parse(backup); // 回滚，任何错误都不覆盖原数据
    saveState();
    renderAll();
    showImportReport("bad", `导入失败已回滚：${err.message}`);
  }
}

function showImportReport(kind, msg, errors) {
  wbEls.importReport.innerHTML = `
    <div class="verdict ${kind} report">
      <strong>${escapeHtml(msg)}</strong>
      ${errors && errors.length ? `<ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}
    </div>`;
}

function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch {
      showImportReport("bad", "导入失败：文件不是有效的 JSON，原数据未改动。", []);
      return;
    }
    const errors = validateImport(data);
    if (errors.length) {
      showImportReport("bad", `导入被拒绝（${errors.length} 个错误），原数据未改动：`, errors);
      return;
    }
    applyImport(data);
  };
  reader.readAsText(file);
}

// ---------- 渲染入口 ----------
function renderWorkbench() {
  if (!wbEls.gameSelect) return;
  const selected = state.ui.wbGameId;
  wbEls.gameSelect.innerHTML = state.games
    .map((g) => `<option value="${g.id}" ${g.id === selected ? "selected" : ""}>${escapeHtml(g.name)}</option>`)
    .join("");
  if (!state.games.some((g) => g.id === selected)) {
    state.ui.wbGameId = state.games[0]?.id || "";
    wbEls.gameSelect.value = state.ui.wbGameId;
  }
  wbEls.comboStatusFilter.value = state.filters.comboStatus || "all";
  renderVersionPanel();
  renderBuilder();
  renderComboList();
}
window.renderWorkbench = renderWorkbench;

// ---------- 事件 ----------
wbEls.gameSelect.addEventListener("change", () => {
  state.ui.wbGameId = wbEls.gameSelect.value;
  resetBuilder();
  resetVersionForm();
  renderAll();
});

wbEls.versionKind.addEventListener("change", updateKindLabels);
wbEls.versionForm.addEventListener("submit", saveVersion);
wbEls.versionCancelEdit.addEventListener("click", () => {
  resetVersionForm();
  renderAll();
});

wbEls.versionRequires.addEventListener("change", (event) => {
  const id = event.target.dataset.reqId;
  if (!id) return;
  event.target.checked ? versionChecks.requires.add(id) : versionChecks.requires.delete(id);
});
wbEls.versionExcludes.addEventListener("change", (event) => {
  const id = event.target.dataset.exclId;
  if (!id) return;
  event.target.checked ? versionChecks.excludes.add(id) : versionChecks.excludes.delete(id);
});

wbEls.versionList.addEventListener("click", (event) => {
  const editBtn = event.target.closest("[data-version-edit]");
  const historyBtn = event.target.closest("[data-version-history]");
  if (editBtn) editVersion(editBtn.dataset.versionEdit);
  if (historyBtn) {
    const id = historyBtn.dataset.versionHistory;
    openVersionHistory.has(id) ? openVersionHistory.delete(id) : openVersionHistory.add(id);
    renderAll();
  }
});

wbEls.genBaseBtn.addEventListener("click", () => {
  const game = state.games.find((g) => g.id === state.ui.wbGameId);
  if (!game) return;
  state.versions.push(
    touch({
      id: crypto.randomUUID(),
      gameId: game.id,
      kind: "base",
      name: "标准版",
      requires: [],
      excludes: [],
      minDelta: game.minPlayers,
      maxDelta: game.maxPlayers,
      durationDelta: game.duration,
      effects: [],
      history: []
    })
  );
  renderAll();
});

wbEls.comboName.addEventListener("input", () => {
  builder.name = wbEls.comboName.value.trim();
  persistBuilder();
});
wbEls.comboBase.addEventListener("change", () => {
  builder.baseId = wbEls.comboBase.value;
  persistBuilder();
  renderVerdict();
});
wbEls.comboPlayers.addEventListener("input", () => {
  builder.players = Number(wbEls.comboPlayers.value) || 0;
  persistBuilder();
  renderVerdict();
});
wbEls.comboExps.addEventListener("change", (event) => {
  const id = event.target.dataset.expId;
  if (!id) return;
  event.target.checked ? builder.expIds.push(id) : (builder.expIds = builder.expIds.filter((x) => x !== id));
  persistBuilder();
  renderVerdict();
});

wbEls.saveDraftBtn.addEventListener("click", () => saveCombo(false));
wbEls.publishBtn.addEventListener("click", () => saveCombo(true));
wbEls.cancelComboEdit.addEventListener("click", () => {
  resetBuilder();
  renderAll();
});
wbEls.comboForm.addEventListener("submit", (event) => event.preventDefault());

wbEls.comboStatusFilter.addEventListener("change", () => {
  state.filters.comboStatus = wbEls.comboStatusFilter.value;
  renderAll();
});

wbEls.comboList.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-combo-action]");
  if (!btn) return;
  const { comboAction: action, comboId: id } = btn.dataset;
  if (action === "edit") editCombo(id);
  else if (action === "history") {
    openHistory.has(id) ? openHistory.delete(id) : openHistory.add(id);
    renderAll();
  } else comboAction(id, action);
});

wbEls.exportBtn.addEventListener("click", exportData);
wbEls.importBtn.addEventListener("click", () => wbEls.importFile.click());
wbEls.importFile.addEventListener("change", () => {
  handleImportFile(wbEls.importFile.files[0]);
  wbEls.importFile.value = "";
});

// 初始化：恢复编辑器草稿后再渲染
restoreBuilder();
updateKindLabels();
renderWorkbench();
