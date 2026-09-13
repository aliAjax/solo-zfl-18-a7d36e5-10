import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:8123";
const KEY = "zfl18-boardgame-rule-cards";
let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

const versionCard = (name) => page.locator(".version-card", { has: page.locator("strong", { hasText: name }) });
const comboCard = (name) => page.locator(".combo-card", { has: page.locator("strong", { hasText: name }) });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("pageerror", (err) => console.log("  PAGEERROR:", err.message));

await page.goto(BASE);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector("#tabWorkbench");

// ============ 0. 原有功能回归：搜索 / 增删 / 本地保存 ============
console.log("\n[0] 原有收藏功能");
await page.fill("#nameInput", "勃艮第城堡");
await page.fill("#lastPlayedInput", "2026-09-01");
await page.click("#gameForm button[type=submit]");
await page.waitForSelector(".game-card");
check("新增桌游出现在列表", (await page.locator(".game-card", { hasText: "勃艮第城堡" }).count()) === 1);
await page.fill("#searchInput", "勃艮第");
check("搜索筛选生效", (await page.locator("#visibleCount").textContent()).includes("1个匹配"));
await page.fill("#searchInput", "");
await page.locator(".game-card", { hasText: "勃艮第城堡" }).click();
await page.waitForSelector("#detailView .rule-list li", { hasText: "本局开始前" });
await page.locator("#detailView .rule-list li", { hasText: "本局开始前" }).locator("button").click();
check("删除规则卡片", (await page.locator("#detailView .rule-list li", { hasText: "本局开始前" }).count()) === 0);
await page.reload();
await page.waitForSelector("#gameList");
check("刷新后本地保存仍在", (await page.locator(".game-card", { hasText: "勃艮第城堡" }).count()) === 1);

// ============ 1. 组合验算 + 冲突阻断 ============
console.log("\n[1] 组合验算与冲突阻断");
await page.click("#tabWorkbench");
await page.waitForSelector("#comboForm");

// 有效组合 → 可发布
await page.fill("#comboName", "四人基础局");
await page.fill("#comboPlayers", "4");
await page.waitForSelector(".verdict.ok");
check("有效组合判定可玩", (await page.locator("#comboVerdict").textContent()).includes("可玩"));
await page.click("#publishBtn");
await page.waitForSelector(".combo-card.published");
check("发布后出现在组合管理", (await comboCard("四人基础局").count()) === 1);

// 缺少依赖 → 拦住
await page.fill("#comboName", "瘟疫局");
await page.locator("#comboExps .check-item", { hasText: "瘟疫蔓延" }).locator("input").check();
await page.waitForSelector("#comboVerdict.bad");
const verdict1 = await page.locator("#comboVerdict").textContent();
check("缺少依赖被拦住", verdict1.includes("缺少依赖") && verdict1.includes("贸易版图"));
check("发布按钮被禁用", await page.locator("#publishBtn").isDisabled());

// 补上依赖 → 可玩，人数时长修正生效
await page.locator("#comboExps .check-item", { hasText: "贸易版图" }).locator("input").check();
await page.waitForSelector("#comboVerdict.ok");
const verdict2 = await page.locator("#comboVerdict").textContent();
check("依赖补齐后可玩", verdict2.includes("可玩"));
check("人数时长修正生效（2-5人·125分钟）", verdict2.includes("2-5 人") && verdict2.includes("125 分钟"));

// 人数超出范围 → 拦住
await page.fill("#comboPlayers", "6");
await page.waitForSelector("#comboVerdict.bad");
check("人数超范围被拦住", (await page.locator("#comboVerdict").textContent()).includes("超出该组合允许范围"));
await page.fill("#comboPlayers", "4");
await page.waitForSelector("#comboVerdict.ok");

// 效果冲突：登记一个同标签扩展
await page.selectOption("#versionKind", "expansion");
await page.fill("#versionName", "皇家法令");
await page.fill("#versionMinDelta", "0");
await page.fill("#versionMaxDelta", "0");
await page.fill("#versionDurationDelta", "10");
await page.fill("#versionEffects", "起始资源: 每人多 1 工人");
await page.click("#versionForm button[type=submit]");
await versionCard("皇家法令").waitFor();
await page.locator("#comboExps .check-item", { hasText: "皇家法令" }).locator("input").check();
await page.waitForSelector("#comboVerdict.bad");
check("效果冲突被拦住", (await page.locator("#comboVerdict").textContent()).includes("效果冲突"));
check("效果冲突时发布禁用", await page.locator("#publishBtn").isDisabled());
await page.locator("#comboExps .check-item", { hasText: "皇家法令" }).locator("input").uncheck();
await page.waitForSelector("#comboVerdict.ok");

// 循环依赖：让 贸易版图 依赖 瘟疫蔓延
await versionCard("贸易版图").locator("[data-version-edit]").click();
await page.locator("#versionRequires .check-item", { hasText: "瘟疫蔓延" }).locator("input").check();
await page.click("#versionForm button[type=submit]");
await page.waitForSelector("#comboVerdict.bad");
check("循环依赖被拦住", (await page.locator("#comboVerdict").textContent()).includes("循环依赖"));
// 还原
await versionCard("贸易版图").locator("[data-version-edit]").click();
await page.locator("#versionRequires .check-item", { hasText: "瘟疫蔓延" }).locator("input").uncheck();
await page.click("#versionForm button[type=submit]");
await page.waitForSelector("#comboVerdict.ok");
check("解除循环后恢复可玩", (await page.locator("#comboVerdict").textContent()).includes("可玩"));

// 互斥：让 皇家法令 与 瘟疫蔓延 互斥
await versionCard("皇家法令").locator("[data-version-edit]").click();
await page.locator("#versionExcludes .check-item", { hasText: "瘟疫蔓延" }).locator("input").check();
await page.click("#versionForm button[type=submit]");
await page.locator("#comboExps .check-item", { hasText: "皇家法令" }).locator("input").check();
await page.waitForSelector("#comboVerdict.bad");
check("互斥冲突被拦住", (await page.locator("#comboVerdict").textContent()).includes("互斥冲突"));
await page.locator("#comboExps .check-item", { hasText: "皇家法令" }).locator("input").uncheck();

// 存草稿（无效组合也可存草稿，但不可发布）
await page.locator("#comboExps .check-item", { hasText: "瘟疫蔓延" }).locator("input").uncheck();
await page.locator("#comboExps .check-item", { hasText: "贸易版图" }).locator("input").uncheck();
await page.fill("#comboName", "草稿占位");
await page.fill("#comboPlayers", "3");
await page.click("#saveDraftBtn");
await comboCard("草稿占位").waitFor();
check("草稿保存成功", (await page.locator(".combo-card.draft", { has: page.locator("strong", { hasText: "草稿占位" }) }).count()) === 1);

// ============ 2. 换版追溯：修订历史 + 受影响局次 ============
console.log("\n[2] 换版追溯");
// 再登记一个基础版本
await page.selectOption("#versionKind", "base");
await page.fill("#versionName", "二人对决版");
await page.fill("#versionMinDelta", "2");
await page.fill("#versionMaxDelta", "2");
await page.fill("#versionDurationDelta", "60");
await page.click("#versionForm button[type=submit]");
await versionCard("二人对决版").waitFor();

// 记录局次
const pubCard = page.locator(".combo-card.published", { has: page.locator("strong", { hasText: "四人基础局" }) });
await pubCard.locator("[data-combo-action=session]").click();
await page.waitForSelector(".combo-card .session-list .pill");
check("局次记录成功", (await pubCard.locator(".session-list .pill").count()) === 1);
check("新局次未受影响", (await pubCard.locator(".session-list .pill.affected").count()) === 0);

// 编辑组合：更换基础版本
await pubCard.locator("[data-combo-action=edit]").click();
await page.waitForSelector("#cancelComboEdit:not([hidden])");
const duelId = await page.locator("#comboBase option", { hasText: "二人对决版" }).getAttribute("value");
await page.selectOption("#comboBase", duelId);
await page.fill("#comboPlayers", "2");
await page.click("#saveDraftBtn"); // 编辑态 = 保存修订
await comboCard("四人基础局").waitFor();
const cardAfter = comboCard("四人基础局");
check("换版后修订号+1", (await cardAfter.locator(".rev-badge").textContent()).includes("修订 2"));
check("局次标记受影响", (await cardAfter.locator(".session-list .pill.affected").count()) === 1);
await cardAfter.locator("[data-combo-action=history]").click();
const historyText = await cardAfter.locator(".history-list").textContent();
check("历史记录更换基础版本", historyText.includes("更换基础版本") && historyText.includes("二人对决版"));

// 撤销：回到换版前内容
await cardAfter.locator("[data-combo-action=undo]").click();
const cardUndone = comboCard("四人基础局");
check("撤销后回到标准版", (await cardUndone.locator(".version-meta").textContent()).includes("标准版"));
check("撤销也产生新修订", (await cardUndone.locator(".rev-badge").textContent()).includes("修订 3"));

// 归档与恢复
await cardUndone.locator("[data-combo-action=archive]").click();
check("归档成功", (await page.locator(".combo-card.archived", { has: page.locator("strong", { hasText: "四人基础局" }) }).count()) === 1);
await comboCard("四人基础局").locator("[data-combo-action=restore]").click();
check("恢复草稿成功", (await page.locator(".combo-card.draft", { has: page.locator("strong", { hasText: "四人基础局" }) }).count()) === 1);

// ============ 3. 导入导出：校验与回滚 ============
console.log("\n[3] 导入导出与回滚");
const snapshot = await page.evaluate((k) => localStorage.getItem(k), KEY);
const stateNow = JSON.parse(snapshot);
const orleans = stateNow.games.find((g) => g.name === "奥尔良");
const tradeExp = stateNow.versions.find((v) => v.name === "贸易版图");
const plagueExp = stateNow.versions.find((v) => v.name === "瘟疫蔓延");
const stdBase = stateNow.versions.find((v) => v.name === "标准版");

async function importJson(name, obj) {
  const path = `/tmp/${name}.json`;
  writeFileSync(path, JSON.stringify(obj));
  await page.setInputFiles("#importFile", path);
  await page.waitForSelector("#importReport .verdict");
}

// 3a 失效引用 → 拒绝且不覆盖
await importJson("bad-ref", { versions: [{ id: "x1", gameId: orleans.id, kind: "expansion", name: "幽灵扩展", requires: ["no-such-id"], excludes: [], minDelta: 0, maxDelta: 0, durationDelta: 0, effects: [] }] });
let report = await page.locator("#importReport").textContent();
check("失效引用被拒绝", report.includes("失效引用"));
check("失效引用导入未改动数据", (await page.evaluate((k) => localStorage.getItem(k), KEY)) === snapshot);

// 3b 版本冲突 → 拒绝
await importJson("bad-conflict", { versions: [{ ...tradeExp, name: "贸易版图·改" }] });
report = await page.locator("#importReport").textContent();
check("版本冲突被拒绝", report.includes("版本冲突"));
check("版本冲突导入未改动数据", (await page.evaluate((k) => localStorage.getItem(k), KEY)) === snapshot);

// 3c 缺组件 → 拒绝
await importJson("bad-missing", {
  combos: [{ id: "c-bad", gameId: orleans.id, name: "缺组件组合", baseVersionId: stdBase.id, expansionIds: [plagueExp.id], players: 4, status: "draft", revision: 1, history: [] }]
});
report = await page.locator("#importReport").textContent();
check("缺组件被拒绝", report.includes("缺组件"));
check("缺组件导入未改动数据", (await page.evaluate((k) => localStorage.getItem(k), KEY)) === snapshot);

// 3d 重复组合 → 拒绝（撤销后四人基础局为 标准版+无扩展+4人）
await importJson("bad-dup", {
  combos: [{ id: "c-dup", gameId: orleans.id, name: "换皮重复", baseVersionId: stdBase.id, expansionIds: [], players: 4, status: "draft", revision: 1, history: [] }]
});
report = await page.locator("#importReport").textContent();
check("重复组合被拒绝", report.includes("重复组合"));
check("重复组合导入未改动数据", (await page.evaluate((k) => localStorage.getItem(k), KEY)) === snapshot);

// 3e 合法导入 → 成功合并
await importJson("good", {
  games: [{ id: "g-new", name: "卡卡颂", minPlayers: 2, maxPlayers: 5, duration: 45, complexity: "轻", lastPlayed: "2026-09-10", cover: "", forgets: [], disputes: [], setup: [], scoring: [] }],
  versions: [{ id: "v-new", gameId: "g-new", kind: "base", name: "标准版", requires: [], excludes: [], minDelta: 2, maxDelta: 5, durationDelta: 45, effects: [] }],
  combos: [{ id: "c-new", gameId: "g-new", name: "卡卡颂二人局", baseVersionId: "v-new", expansionIds: [], players: 2, status: "published", revision: 1, history: [] }]
});
report = await page.locator("#importReport").textContent();
check("合法导入成功", report.includes("导入成功"));
const afterImport = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), KEY));
check("导入后新桌游入库", afterImport.games.some((g) => g.name === "卡卡颂"));
check("导入后原数据保留", afterImport.games.some((g) => g.name === "奥尔良") && afterImport.combos.some((c) => c.name === "四人基础局"));

// 导出：验证导出内容可解析
const downloadPromise = page.waitForEvent("download");
await page.click("#exportBtn");
const download = await downloadPromise;
check("导出文件生成", (await download.suggestedFilename()).endsWith(".json"));

// ============ 4. 刷新恢复：筛选 + 草稿 ============
console.log("\n[4] 刷新恢复");
await page.click("#tabCollection");
await page.fill("#searchInput", "奥尔良");
await page.selectOption("#sortMode", "name");
await page.click("#tabWorkbench");
await page.selectOption("#wbGameSelect", orleans.id);
await page.fill("#comboName", "恢复测试草稿");
await page.locator("#comboExps .check-item", { hasText: "贸易版图" }).locator("input").check();
await page.reload();
await page.waitForSelector("#workbenchView:not([hidden])");
check("刷新后停留在验算台", await page.locator("#workbenchView").isVisible());
check("刷新后草稿名称恢复", (await page.locator("#comboName").inputValue()) === "恢复测试草稿");
check("刷新后草稿扩展勾选恢复", await page.locator("#comboExps .check-item", { hasText: "贸易版图" }).locator("input").isChecked());
await page.click("#tabCollection");
check("刷新后搜索筛选恢复", (await page.locator("#searchInput").inputValue()) === "奥尔良");
check("刷新后排序恢复", (await page.locator("#sortMode").inputValue()) === "name");
check("筛选结果正确", (await page.locator("#visibleCount").textContent()).includes("1个匹配"));
await page.fill("#searchInput", "");

// ============ 5. 多页合并：修改同步 + 冲突不静默覆盖 ============
console.log("\n[5] 多页合并");
const page2 = await ctx.newPage();
await page2.goto(BASE);
await page2.waitForSelector("#gameList");
// 页面1新增桌游 → 页面2自动出现
await page.fill("#nameInput", "现代艺术");
await page.fill("#lastPlayedInput", "2026-09-12");
await page.click("#gameForm button[type=submit]");
await page2.waitForSelector(".game-card", { hasText: "现代艺术" });
check("多页修改自动合并", (await page2.locator(".game-card", { hasText: "现代艺术" }).count()) === 1);

// 制造同修订号冲突：页面2直接改写 localStorage（模拟并发页）
await page2.evaluate((k) => {
  const data = JSON.parse(localStorage.getItem(k));
  const target = data.games.find((g) => g.name === "现代艺术");
  target.name = "现代艺术·另一页改名";
  data.meta.tabId = "other-tab";
  localStorage.setItem(k, JSON.stringify(data));
}, KEY);
await page.waitForSelector("#conflictBanner .conflict-box");
check("冲突横幅出现", (await page.locator("#conflictBanner .conflict-item").count()) === 1);
check("本地数据未被静默覆盖", (await page.locator(".game-card", { hasText: "现代艺术·另一页改名" }).count()) === 0);
await page.click("#conflictBanner [data-keep=local]");
await page.waitForSelector("#conflictBanner .conflict-box", { state: "detached" });
check("选择保留本页后冲突消除", (await page.locator("#conflictBanner .conflict-box").count()) === 0);
await page2.waitForFunction(
  (k) => !JSON.parse(localStorage.getItem(k)).games.some((g) => g.name === "现代艺术·另一页改名"),
  KEY
);
check("对端页面最终收敛一致", true);

await page2.close();
await browser.close();

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
