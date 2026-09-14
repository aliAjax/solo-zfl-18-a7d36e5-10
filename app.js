const storageKey = "zfl18-boardgame-rule-cards";
const builderKey = `${storageKey}:builder`;
const today = new Date();
const tabId = crypto.randomUUID();
const COLLECTIONS = ["games", "versions", "combos", "sessions"];

// ---------- 种子数据 ----------
const seed = {
  g1: crypto.randomUUID(),
  g2: crypto.randomUUID(),
  g3: crypto.randomUUID(),
  v1: crypto.randomUUID(),
  v2: crypto.randomUUID(),
  v3: crypto.randomUUID()
};

const defaultState = {
  selectedId: seed.g1,
  games: [
    {
      id: seed.g1,
      name: "奥尔良",
      minPlayers: 2,
      maxPlayers: 4,
      duration: 90,
      complexity: "中",
      lastPlayed: "2025-11-20",
      cover: "",
      forgets: ["商站建造前先确认道路或水路连接", "袋中随从抽完后不是重洗弃堆，而是从已回袋内容继续抽"],
      disputes: ["事件顺序和玩家动作结算先后", "科技板是否能替代所有同类随从"],
      setup: ["按人数放置货物板块", "每位玩家拿起始随从、商人和个人板"],
      scoring: ["货物分数", "商站和市民乘区块", "金币和建筑剩余加分"],
      rev: 1
    },
    {
      id: seed.g2,
      name: "盖亚计划",
      minPlayers: 1,
      maxPlayers: 4,
      duration: 150,
      complexity: "重",
      lastPlayed: "2025-08-02",
      cover: "",
      forgets: ["联邦连接时卫星数量和能量消耗要一起核对", "研究升到顶必须拿对应科技板限制"],
      disputes: ["被动充能是否能拒绝", "星球改造费用受哪些能力影响"],
      setup: ["随机终局计分板和回合得分板", "按种族设置起始资源和母星"],
      scoring: ["终局计分板", "科技轨排名", "联邦和建筑分"],
      rev: 1
    },
    {
      id: seed.g3,
      name: "花砖物语",
      minPlayers: 2,
      maxPlayers: 4,
      duration: 45,
      complexity: "轻",
      lastPlayed: "2026-03-15",
      cover: "",
      forgets: ["每轮结束先铺墙再补工厂展示区", "地板线扣分后清空对应砖"],
      disputes: ["同色砖放置限制是否看整面墙", "中央区起始玩家标记是否必须拿"],
      setup: ["按人数放工厂圆盘", "每个圆盘补4块砖"],
      scoring: ["横竖相邻即时分", "完整行列和颜色终局加分"],
      rev: 1
    }
  ],
  versions: [
    {
      id: seed.v1,
      gameId: seed.g1,
      kind: "base",
      name: "标准版",
      requires: [],
      excludes: [],
      minDelta: 2,
      maxDelta: 4,
      durationDelta: 90,
      effects: [],
      rev: 1,
      history: []
    },
    {
      id: seed.v2,
      gameId: seed.g1,
      kind: "expansion",
      name: "贸易版图",
      requires: [],
      excludes: [],
      minDelta: 0,
      maxDelta: 1,
      durationDelta: 20,
      effects: [{ tag: "起始资源", text: "每人开局多 2 金币" }],
      rev: 1,
      history: []
    },
    {
      id: seed.v3,
      gameId: seed.g1,
      kind: "expansion",
      name: "瘟疫蔓延",
      requires: [seed.v2],
      excludes: [],
      minDelta: 0,
      maxDelta: 0,
      durationDelta: 15,
      effects: [{ tag: "事件", text: "加入瘟疫事件牌" }],
      rev: 1,
      history: []
    }
  ],
  combos: [],
  sessions: [],
  tombstones: { games: {}, versions: {}, combos: {}, sessions: {} },
  conflicts: [],
  filters: { keyword: "", player: "all", complexity: "all", sort: "stale" },
  ui: { tab: "collection", wbGameId: "" },
  meta: { rev: 1, tabId: "" }
};

let state = loadState();
migrateState();
if (!state.selectedId) state.selectedId = state.games[0]?.id || "";
if (!state.ui.wbGameId) state.ui.wbGameId = state.selectedId;

// ---------- 状态读写 / 迁移 ----------
function loadState() {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return structuredClone(defaultState);
  try {
    return { ...structuredClone(defaultState), ...JSON.parse(saved) };
  } catch {
    return structuredClone(defaultState);
  }
}

function migrateState() {
  state.games = Array.isArray(state.games) ? state.games : [];
  state.versions = Array.isArray(state.versions) ? state.versions : [];
  state.combos = Array.isArray(state.combos) ? state.combos : [];
  state.sessions = Array.isArray(state.sessions) ? state.sessions : [];
  state.conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
  state.tombstones = state.tombstones || {};
  for (const col of COLLECTIONS) state.tombstones[col] = state.tombstones[col] || {};
  state.filters = { keyword: "", player: "all", complexity: "all", sort: "stale", ...(state.filters || {}) };
  state.ui = { tab: "collection", wbGameId: "", ...(state.ui || {}) };
  state.meta = state.meta || { rev: 0, tabId: "" };
  let maxRev = Number(state.meta.rev) || 0;
  for (const col of COLLECTIONS) {
    for (const entity of state[col]) {
      entity.rev = Number(entity.rev) || 0;
      maxRev = Math.max(maxRev, entity.rev);
    }
  }
  state.meta.rev = maxRev;
}

function saveState() {
  state.meta.tabId = tabId;
  localStorage.setItem(storageKey, JSON.stringify(state));
}

// 每次实体改动都推进全局修订号，供多页合并比较
function touch(entity) {
  state.meta.rev += 1;
  entity.rev = state.meta.rev;
  return entity;
}

function deleteFromCollection(collection, id) {
  state.meta.rev += 1;
  state.tombstones[collection][id] = state.meta.rev;
  state[collection] = state[collection].filter((item) => item.id !== id);
}

// ---------- 多页合并：按实体修订号合并，冲突不静默覆盖 ----------
function fingerprint(entity) {
  if (entity == null) return "∅";
  const copy = { ...entity };
  delete copy.rev;
  return JSON.stringify(copy);
}

function pushConflict(entry) {
  const dup = state.conflicts.some(
    (item) =>
      item.collection === entry.collection &&
      item.id === entry.id &&
      fingerprint(item.local) === fingerprint(entry.local) &&
      fingerprint(item.remote) === fingerprint(entry.remote)
  );
  if (dup) return false;
  state.conflicts.push(entry);
  return true;
}

function mergeRemote(remote) {
  if (!remote || !remote.meta) return false;
  let changed = false;
  const newTombs = { games: new Set(), versions: new Set(), combos: new Set(), sessions: new Set() };

  for (const col of COLLECTIONS) {
    const remoteTomb = remote.tombstones?.[col] || {};
    for (const [id, rev] of Object.entries(remoteTomb)) {
      if (rev > (state.tombstones[col][id] || 0)) {
        state.tombstones[col][id] = rev;
        newTombs[col].add(id);
        changed = true;
      }
    }
  }

  for (const col of COLLECTIONS) {
    const localArr = state[col];
    const tombs = state.tombstones[col];
    for (const remoteEntity of remote[col] || []) {
      const tombRev = tombs[remoteEntity.id] || 0;
      const remoteRev = remoteEntity.rev || 0;
      if (tombRev > remoteRev) continue; // 删除晚于该编辑，静默生效
      if (tombRev > 0 && tombRev === remoteRev) {
        // 远端编辑与删除并发相撞：记录冲突，不静默选边，实体暂不恢复
        const localEntity = localArr.find((item) => item.id === remoteEntity.id) || null;
        // 双方保留的内容完全一致时，删除冲突已在本地记录过，不重复计
        if (localEntity && fingerprint(localEntity) === fingerprint(remoteEntity)) continue;
        if (pushConflict({ collection: col, id: remoteEntity.id, local: localEntity, remote: remoteEntity })) changed = true;
        continue;
      }
      const index = localArr.findIndex((item) => item.id === remoteEntity.id);
      if (index === -1) {
        localArr.push(remoteEntity);
        changed = true;
        continue;
      }
      const localEntity = localArr[index];
      const localRev = localEntity.rev || 0;
      if (remoteRev > localRev) {
        localArr[index] = remoteEntity;
        changed = true;
      } else if (remoteRev === localRev && fingerprint(localEntity) !== fingerprint(remoteEntity)) {
        // 同一修订号内容却不同：两个页面同时改了同一实体，记录冲突而不是覆盖
        if (pushConflict({ collection: col, id: remoteEntity.id, local: localEntity, remote: remoteEntity })) changed = true;
      }
    }
    // 本地实体 vs 墓碑：仅当墓碑是本次合并新获知时才判定为相撞；
    // 旧墓碑+高修订实体是已解决/已收敛的状态，不重复记冲突
    const kept = [];
    for (const item of localArr) {
      const tombRev = tombs[item.id] || 0;
      if (!tombRev) {
        kept.push(item);
      } else if ((item.rev || 0) >= tombRev) {
        if (newTombs[col].has(item.id) && pushConflict({ collection: col, id: item.id, local: item, remote: null })) changed = true;
        kept.push(item);
      } else {
        changed = true; // 删除晚于编辑，静默生效
      }
    }
    state[col] = kept;
  }

  const remoteRev = Number(remote.meta.rev) || 0;
  if (remoteRev > state.meta.rev) {
    state.meta.rev = remoteRev;
    changed = true;
  }
  return changed;
}

function resolveConflict(conflict, keep) {
  const winner = keep === "remote" ? conflict.remote : conflict.local;
  if (winner) {
    const adopted = { ...winner };
    touch(adopted); // 提升修订号，下一轮同步时胜出（也盖过墓碑）
    const arr = state[conflict.collection];
    const index = arr.findIndex((item) => item.id === conflict.id);
    if (index === -1) arr.push(adopted);
    else arr[index] = adopted;
  } else {
    // 获胜方是“已删除”：提升墓碑修订号并移除实体
    state.meta.rev += 1;
    state.tombstones[conflict.collection][conflict.id] = state.meta.rev;
    state[conflict.collection] = state[conflict.collection].filter((item) => item.id !== conflict.id);
  }
  state.conflicts = state.conflicts.filter((item) => item !== conflict);
  renderAll();
}

window.addEventListener("storage", (event) => {
  if (event.key !== storageKey || !event.newValue) return;
  let remote;
  try {
    remote = JSON.parse(event.newValue);
  } catch {
    return;
  }
  if (!remote?.meta || remote.meta.tabId === tabId) return;
  const changed = mergeRemote(remote);
  if (changed) {
    renderAll(false);
    saveState(); // 收敛合并结果；对端再合并时无变化即停止
  }
});

// ---------- 收藏：筛选 / 渲染 ----------
const els = {
  searchInput: document.querySelector("#searchInput"),
  playerFilter: document.querySelector("#playerFilter"),
  complexityFilter: document.querySelector("#complexityFilter"),
  sortMode: document.querySelector("#sortMode"),
  gameForm: document.querySelector("#gameForm"),
  nameInput: document.querySelector("#nameInput"),
  minPlayersInput: document.querySelector("#minPlayersInput"),
  maxPlayersInput: document.querySelector("#maxPlayersInput"),
  durationInput: document.querySelector("#durationInput"),
  complexityInput: document.querySelector("#complexityInput"),
  lastPlayedInput: document.querySelector("#lastPlayedInput"),
  coverInput: document.querySelector("#coverInput"),
  gameList: document.querySelector("#gameList"),
  detailView: document.querySelector("#detailView"),
  gameCount: document.querySelector("#gameCount"),
  ruleCount: document.querySelector("#ruleCount"),
  staleGame: document.querySelector("#staleGame"),
  visibleCount: document.querySelector("#visibleCount"),
  conflictBanner: document.querySelector("#conflictBanner"),
  tabCollection: document.querySelector("#tabCollection"),
  tabWorkbench: document.querySelector("#tabWorkbench"),
  collectionView: document.querySelector("#collectionView"),
  workbenchView: document.querySelector("#workbenchView")
};

function restoreFilters() {
  els.searchInput.value = state.filters.keyword;
  els.playerFilter.value = state.filters.player;
  els.complexityFilter.value = state.filters.complexity;
  els.sortMode.value = state.filters.sort;
}

function persistFilters() {
  state.filters = {
    keyword: els.searchInput.value,
    player: els.playerFilter.value,
    complexity: els.complexityFilter.value,
    sort: els.sortMode.value
  };
}

function daysSince(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return Math.max(0, Math.floor((today - date) / 86400000));
}

function getAllRules(game) {
  return [...game.forgets, ...game.disputes, ...game.setup, ...game.scoring];
}

function getFilteredGames() {
  const keyword = els.searchInput.value.trim();
  const player = els.playerFilter.value;
  const complexity = els.complexityFilter.value;
  const games = state.games.filter((game) => {
    const text = `${game.name}${getAllRules(game).join("")}`;
    const matchesKeyword = !keyword || text.includes(keyword);
    const matchesPlayer = player === "all" || (Number(player) >= game.minPlayers && Number(player) <= game.maxPlayers);
    const matchesComplexity = complexity === "all" || game.complexity === complexity;
    return matchesKeyword && matchesPlayer && matchesComplexity;
  });

  if (els.sortMode.value === "name") return games.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  if (els.sortMode.value === "complexity") {
    const rank = { 轻: 1, 中: 2, 重: 3 };
    return games.sort((a, b) => rank[b.complexity] - rank[a.complexity]);
  }
  return games.sort((a, b) => daysSince(b.lastPlayed) - daysSince(a.lastPlayed));
}

function renderSummary() {
  const allRuleCount = state.games.reduce((sum, game) => sum + getAllRules(game).length, 0);
  const stale = [...state.games].sort((a, b) => daysSince(b.lastPlayed) - daysSince(a.lastPlayed))[0];
  els.gameCount.textContent = state.games.length;
  els.ruleCount.textContent = allRuleCount;
  els.staleGame.textContent = stale ? `${daysSince(stale.lastPlayed)}天` : "-";
}

function renderList() {
  const games = getFilteredGames();
  els.visibleCount.textContent = `${games.length}个匹配`;
  els.gameList.innerHTML =
    games
      .map((game) => {
        const selected = game.id === state.selectedId ? "selected" : "";
        return `
          <article class="game-card ${selected}" data-game-id="${game.id}">
            <div class="cover">
              ${
                game.cover
                  ? `<img src="${game.cover}" alt="${escapeHtml(game.name)}封面" />`
                  : `<span>${escapeHtml(game.name.slice(0, 2))}</span>`
              }
              <span class="stale-ribbon">${daysSince(game.lastPlayed)}天未玩</span>
            </div>
            <div class="game-body">
              <h3>${escapeHtml(game.name)}</h3>
              <div class="game-meta">
                <span class="pill">${game.minPlayers}-${game.maxPlayers}人</span>
                <span class="pill">${game.duration}分钟</span>
                <span class="pill heavy">${escapeHtml(game.complexity)}</span>
              </div>
            </div>
          </article>
        `;
      })
      .join("") || `<p class="empty">没有符合筛选的桌游。</p>`;
}

function renderDetail() {
  const game = state.games.find((item) => item.id === state.selectedId) || state.games[0];
  if (!game) {
    els.detailView.innerHTML = `<p class="empty">先添加一个桌游。</p>`;
    return;
  }
  state.selectedId = game.id;
  els.detailView.innerHTML = `
    <div class="quick-card">
      <div class="detail-cover">
        ${game.cover ? `<img src="${game.cover}" alt="${escapeHtml(game.name)}封面" />` : `<span>${escapeHtml(game.name.slice(0, 2))}</span>`}
      </div>
      <div>
        <h2>${escapeHtml(game.name)}</h2>
        <div class="game-meta">
          <span class="pill">${game.minPlayers}-${game.maxPlayers}人</span>
          <span class="pill">${game.duration}分钟</span>
          <span class="pill heavy">${escapeHtml(game.complexity)}</span>
          <span class="pill">${daysSince(game.lastPlayed)}天未玩</span>
        </div>
      </div>
      ${renderRuleSection("容易忘的规则", "forgets", game.forgets)}
      ${renderRuleSection("常见争议", "disputes", game.disputes)}
      ${renderRuleSection("开局准备", "setup", game.setup)}
      ${renderRuleSection("计分提醒", "scoring", game.scoring)}
      <form class="add-rule" id="ruleForm">
        <select id="ruleTypeInput">
          <option value="forgets">容易忘的规则</option>
          <option value="disputes">常见争议</option>
          <option value="setup">开局准备</option>
          <option value="scoring">计分提醒</option>
        </select>
        <textarea id="ruleTextInput" rows="3" placeholder="补充一条聚会前要看的提醒" required></textarea>
        <button class="primary" type="submit">加入规则卡片</button>
      </form>
      <div class="detail-actions">
        <button id="playedTodayBtn" type="button">标记今天玩过</button>
        <button id="deleteGameBtn" type="button">删除桌游</button>
      </div>
    </div>
  `;
}

function renderRuleSection(title, key, items) {
  return `
    <section class="rule-section">
      <h3>${title}</h3>
      <ul class="rule-list">
        ${
          items
            .map(
              (item, index) => `
                <li>
                  <span>${escapeHtml(item)}</span>
                  <button type="button" title="删除" data-rule-key="${key}" data-rule-index="${index}">×</button>
                </li>
              `
            )
            .join("") || `<li><span>暂无内容。</span></li>`
        }
      </ul>
    </section>
  `;
}

const COLLECTION_LABEL = { games: "桌游", versions: "版本", combos: "组合", sessions: "局次" };

function renderConflicts() {
  if (!state.conflicts.length) {
    els.conflictBanner.innerHTML = "";
    return;
  }
  els.conflictBanner.innerHTML = `
    <div class="conflict-box" role="alert">
      <strong>发现 ${state.conflicts.length} 个多页编辑冲突，未静默覆盖，请手动选择：</strong>
      ${state.conflicts
        .map((conflict, index) => {
          const label = COLLECTION_LABEL[conflict.collection] || conflict.collection;
          const name = conflict.local?.name || conflict.remote?.name || conflict.id;
          const scene =
            conflict.local == null
              ? "本页已将其删除，另一页面却编辑了它"
              : conflict.remote == null
                ? "另一页面已将其删除，本页保留或编辑了它"
                : "两个页面同时编辑了它";
          return `
            <div class="conflict-item">
              <span>【${label}】${escapeHtml(name)}：${scene}（本地「${escapeHtml(conflict.local?.name ?? "已删除")}」/ 对方「${escapeHtml(conflict.remote?.name ?? "已删除")}」）</span>
              <button type="button" data-conflict-index="${index}" data-keep="local">保留本页</button>
              <button type="button" data-conflict-index="${index}" data-keep="remote">采用对方</button>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderTabs() {
  const tab = state.ui.tab;
  els.tabCollection.classList.toggle("active", tab === "collection");
  els.tabWorkbench.classList.toggle("active", tab === "workbench");
  els.collectionView.hidden = tab !== "collection";
  els.workbenchView.hidden = tab !== "workbench";
}

function renderAll(persist = true) {
  if (persist) {
    persistFilters();
    saveState();
  }
  renderTabs();
  renderConflicts();
  renderSummary();
  renderList();
  renderDetail();
  if (typeof window.renderWorkbench === "function") window.renderWorkbench();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

async function addGame(event) {
  event.preventDefault();
  const minPlayers = Number(els.minPlayersInput.value);
  const maxPlayers = Math.max(minPlayers, Number(els.maxPlayersInput.value));
  const cover = await readFileAsDataUrl(els.coverInput.files[0]);
  const game = touch({
    id: crypto.randomUUID(),
    name: els.nameInput.value.trim(),
    minPlayers,
    maxPlayers,
    duration: Number(els.durationInput.value),
    complexity: els.complexityInput.value,
    lastPlayed: els.lastPlayedInput.value,
    cover,
    forgets: ["本局开始前先补充容易忘的规则。"],
    disputes: [],
    setup: ["整理组件并按人数调整初始设置。"],
    scoring: ["确认终局计分项和即时得分项。"]
  });
  state.games.unshift(game);
  state.selectedId = game.id;
  els.gameForm.reset();
  setDefaultDate();
  renderAll();
}

function setDefaultDate() {
  const date = new Date();
  date.setMonth(date.getMonth() - 2);
  els.lastPlayedInput.value = date.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

els.searchInput.addEventListener("input", () => renderAll());
els.playerFilter.addEventListener("change", () => renderAll());
els.complexityFilter.addEventListener("change", () => renderAll());
els.sortMode.addEventListener("change", () => renderAll());
els.gameForm.addEventListener("submit", addGame);

els.tabCollection.addEventListener("click", () => {
  state.ui.tab = "collection";
  renderAll();
});
els.tabWorkbench.addEventListener("click", () => {
  state.ui.tab = "workbench";
  renderAll();
});

els.conflictBanner.addEventListener("click", (event) => {
  const button = event.target.closest("[data-conflict-index]");
  if (!button) return;
  const conflict = state.conflicts[Number(button.dataset.conflictIndex)];
  if (conflict) resolveConflict(conflict, button.dataset.keep);
});

els.gameList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-game-id]");
  if (!card) return;
  state.selectedId = card.dataset.gameId;
  renderAll();
});

els.detailView.addEventListener("submit", (event) => {
  if (event.target.id !== "ruleForm") return;
  event.preventDefault();
  const game = state.games.find((item) => item.id === state.selectedId);
  if (!game) return;
  const key = document.querySelector("#ruleTypeInput").value;
  const text = document.querySelector("#ruleTextInput").value.trim();
  if (!text) return;
  game[key].push(text);
  touch(game);
  renderAll();
});

els.detailView.addEventListener("click", (event) => {
  const ruleButton = event.target.closest("[data-rule-key]");
  const playedButton = event.target.closest("#playedTodayBtn");
  const deleteButton = event.target.closest("#deleteGameBtn");
  const game = state.games.find((item) => item.id === state.selectedId);
  if (!game) return;

  if (ruleButton) {
    const key = ruleButton.dataset.ruleKey;
    const index = Number(ruleButton.dataset.ruleIndex);
    game[key].splice(index, 1);
    touch(game);
    renderAll();
  }

  if (playedButton) {
    game.lastPlayed = new Date().toISOString().slice(0, 10);
    touch(game);
    renderAll();
  }

  if (deleteButton) {
    // 级联删除该游戏的版本、组合和局次，避免留下失效引用
    const versionIds = state.versions.filter((v) => v.gameId === game.id).map((v) => v.id);
    const comboIds = state.combos.filter((c) => c.gameId === game.id).map((c) => c.id);
    for (const id of versionIds) deleteFromCollection("versions", id);
    for (const id of comboIds) deleteFromCollection("combos", id);
    for (const session of state.sessions.filter((s) => comboIds.includes(s.comboId))) {
      deleteFromCollection("sessions", session.id);
    }
    deleteFromCollection("games", game.id);
    state.selectedId = state.games[0]?.id || "";
    renderAll();
  }
});

restoreFilters();
setDefaultDate();
renderAll(false);
