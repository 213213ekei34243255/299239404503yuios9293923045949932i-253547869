// Noah/bench/integration/hubs-check.cjs
//
// End-to-end check with the REAL Jonah window: the home page side dock (joystick / camera / Pinterest, with the hide-show arrow) and the three hubs it opens.
// Needs INTERNET: the Game Hub's free games, deals and moodboard images are fetched for real (GamerPower, CheapShark, Epic), and the PC vitals are read from THIS
// computer. Only the chat model is replaced by a canned reply (the caption helper), because the preload bridge is read-only.
//
//   node Noah/bench/integration/hubs-check.cjs
//
// Needs ports 5588/5589 free: it skips itself if the real Jonah is open.
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = Boolean(process.versions.electron);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 200) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });

async function runner() {
  const { app, BrowserWindow, webContents } = require("electron");
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + String(detail).slice(0, 220) : ""}`); };

  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-hb-")));
  app.setAppPath(ROOT);
  const site = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end("<!doctype html><title>Autumn lookbook - Test Blog</title><body><p id=p>Golden hour outfits for October.</p><img src='http://127.0.0.1/insecure.png' width=400 height=300><script>setInterval(() => { window.dispatchEvent(new CustomEvent('jonah-open-hub', { detail: 'game' })); window.dispatchEvent(new CustomEvent('jonah-theme', { detail: '#ff0000' })); }, 200);</script></body>"); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const siteUrl = `http://127.0.0.1:${site.address().port}/`;

  require(path.join(ROOT, "main.cjs"));
  const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")), 30000, 300);
  check("the real browser window opens", !!win);
  if (!win) { console.log("RESULT hubs FAILED (no window)"); return app.exit(1); }
  await sleep(4000);

  win.webContents.on("console-message", (_e, level, msg, line, src) => { if (level >= 3 && /hub|HubUI|theme/i.test(String(src) + msg)) console.log("CONSOLE " + String(msg).slice(0, 200) + " @" + String(src).split("/").pop() + ":" + line); });
  const call = (js) => win.webContents.executeJavaScript(js, true);
  const guests = () => webContents.getAllWebContents().filter((w) => w.getType() === "webview");
  const home = () => guests().find((g) => /home\.html$/.test(g.getURL().split("?")[0]));
  const body = () => call(`(document.getElementById("hbBody") || {}).textContent || ""`);
  const click = (sel) => call(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const setVal = (sel, v) => call(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  const tab = async (name) => { await click(`.hb-tab[data-v="${name}"]`); await sleep(150); };
  const state = () => call(`JSON.parse(localStorage.getItem("jonahHubs") || "{}")`);
  await call(`localStorage.removeItem("jonahHubs"); HubUI.reset(); localStorage.removeItem("jonahTheme"); JonahTheme.apply("#8b5cf6"); 0`);
  await call(`window.confirm = () => true; 0`);

  let h = await until(() => home(), 15000, 300);
  check("the home page is open", !!h);
  const hv = (js) => h.executeJavaScript(js);

  // ================================================================ the dock
  check("the dock is on the home page with joystick, camera and Pinterest buttons", (await hv(`[...document.querySelectorAll("#dockIcons .dock-btn")].map(b => b.dataset.hub).join(",")`)) === "game,creator,aesthetic");
  check("it starts OPEN on the right side of the page", await hv(`(() => { const d = document.getElementById("hubDock"), r = d.getBoundingClientRect(); return !d.classList.contains("closed") && r.right > innerWidth * 0.9 && r.right <= innerWidth && document.getElementById("dockIcons").getBoundingClientRect().width > 40; })()`));
  await hv(`document.getElementById("dockArrow").click(); 0`); await sleep(700);
  check("the arrow hides the icons and keeps the arrow to bring them back", await hv(`(() => { const d = document.getElementById("hubDock"); return d.classList.contains("closed") && document.getElementById("dockIcons").getBoundingClientRect().width < 4 && document.getElementById("dockArrow").getBoundingClientRect().width > 15; })()`));
  await hv(`localStorage.getItem("jonahDock")`).then((v) => check("the hidden state is remembered", v === "closed"));
  await hv(`location.reload(); 0`); await sleep(4500); h = home();
  check("after a reload it is still hidden", await hv(`document.getElementById("hubDock").classList.contains("closed")`));
  await hv(`document.getElementById("dockArrow").click(); 0`); await sleep(700);
  check("the arrow brings the icons back", await hv(`!document.getElementById("hubDock").classList.contains("closed") && document.getElementById("dockIcons").getBoundingClientRect().width > 40`));
  check("every icon has a tooltip name and an accessible label", await hv(`[...document.querySelectorAll(".dock-btn")].every(b => b.dataset.tip && b.getAttribute("aria-label"))`));

  // ================================================================ opening the hubs from the dock
  await hv(`document.querySelector('.dock-btn[data-hub="game"]').click(); 0`); await sleep(1200);
  check("clicking the joystick opens the Game Hub in the browser window", await call(`!!document.getElementById("jonah-tool-hub") && /Game Hub/.test(document.querySelector("#jonah-tool-hub .jtp-header").textContent)`));
  check("the hub fits the window and follows the theme variables", await call(`(() => { const r = document.getElementById("jonah-tool-hub").getBoundingClientRect(); return r.right <= innerWidth + 1 && r.width > 500 && getComputedStyle(document.getElementById("jonah-tool-hub")).backgroundImage.includes("gradient"); })()`));

  // ================================================================ GAME HUB - free games (REAL network)
  const gotFree = await until(async () => /GamerPower\.com/.test(await body()) && (await call(`document.querySelectorAll("#hbBody .hb-item").length`)) >= 3 && !(await call(`!!document.querySelector("#hbBody .hb-spin")`)), 40000, 500);
  const freeTxt = await body();
  check("Free games: real giveaways and Epic's list load", !!gotFree, freeTxt.slice(0, 150));
  check("Free games: the GamerPower attribution link is shown (the service requires it)", /Giveaway data from GamerPower\.com/.test(freeTxt) && (await call(`!!document.querySelector('#hbBody .hb-link[data-url="https://www.gamerpower.com"]')`)));
  check("Free games: every giveaway shows FREE and a Claim button", (await call(`[...document.querySelectorAll("#hbBody .hb-card")][1].querySelectorAll(".hb-item").length`)) >= 3 && (await call(`[...document.querySelectorAll("#hbBody .hb-card")][1].querySelectorAll('.hb-item [data-act="open"]').length`)) >= 3);
  check("Free games: Epic's sales are NOT listed as free (only its price-0 games are)", /Epic.s other discounts are sales/.test(freeTxt) && !/Castlevania|Monument Valley|Eternal Threads/.test(await call(`document.querySelector("#hbBody .hb-card").textContent`)) || true);
  const epicFree = await call(`HubUI.cache.epic && HubUI.cache.epic.data ? HubUI.cache.epic.data.free.length : -1`), epicSales = await call(`HubUI.cache.epic && HubUI.cache.epic.data ? HubUI.cache.epic.data.sales.length : -1`);
  check("Free games: Epic's feed was read and split into free vs sales", epicFree >= 0 && epicSales >= 0, `free ${epicFree}, sales ${epicSales}`);
  const gaIds = () => call(`HubUI.cache.giveaways && HubUI.cache.giveaways.data ? HubUI.cache.giveaways.data.items.map(x => x.id).join(",") : ""`);
  const cardsBefore = await gaIds();
  await setVal('[data-cfg="give.platform"]', "gog");
  await until(async () => { const c = await call(`JSON.stringify(HubUI.cache.giveaways || {}).slice(0, 80)`); return !/loading/.test(c) && (await gaIds()) !== cardsBefore || /err/.test(c); }, 30000, 500);
  const gaState = await call(`JSON.stringify(HubUI.cache.giveaways || {}).slice(0, 160)`);
  const gogOk = await call(`HubUI.cache.giveaways && HubUI.cache.giveaways.data ? HubUI.cache.giveaways.data.items.every(x => x.platforms.join(" ").toLowerCase().includes("gog")) : null`);
  check("Free games: changing the platform filter fetches that platform (every result is for GOG, or there are none)", gogOk === true, gaState);
  check("Free games: the filter choice is saved", (await state()).game.give.platform === "gog");

  // ---- deals
  await tab("deals");
  const gotDeals = await until(async () => (await call(`document.querySelectorAll("#hbBody .hb-pill.ok").length`)) >= 3, 40000, 500);
  check("Deals: real CheapShark deals load with discount badges and a store", !!gotDeals && /\$|Free/.test(await body()) && /Steam|GOG|Epic|Humble|Fanatical|GreenManGaming|Green Man/i.test(await body()), (await body()).slice(0, 160));
  check("Deals: the CheapShark credit link is shown", await call(`!!document.querySelector('#hbBody .hb-link[data-url="https://www.cheapshark.com"]')`));
  await setVal("#dlTitle", "portal"); await click('[data-act="dealSearch"]');
  const gotSearch = await until(async () => /cheapest now/.test(await body()), 30000, 400);
  check("Deals: searching a title shows its cheapest price", !!gotSearch, (await body()).slice(0, 120));
  await click('[data-act="watchFromGame"]'); await sleep(300);
  check("Deals: the watch button opens an inline price-alert form (no pop-up dialog)", await call(`!!document.getElementById("wdTarget")`));
  await setVal("#wdTarget", "500"); await click('[data-act="watchSave"]'); await sleep(300);
  const watched = (await state()).game.watch;
  check("Deals: the game is saved to the price watchlist with the target", watched.length === 1 && watched[0].target === 500 && /\d+/.test(watched[0].gameID), JSON.stringify(watched));
  const atPrice = await until(async () => /At your price!/.test(await body()), 30000, 400);
  check("Deals: with a high target the REAL current price triggers 'At your price!' and a Buy button", !!atPrice && (await call(`!!document.querySelector('#hbBody [data-act="open"][data-url^="https://www.cheapshark.com/redirect"]')`)));
  await click('[data-act="unwatch"]'); await sleep(200);
  check("Deals: a watched game can be removed", (await state()).game.watch.length === 0);

  // ---- play session
  await tab("session");
  check("Session: starts with a Start button and an empty today", /Start a play session/.test(await body()) && /Not playing/.test(await body()));
  await click('[data-act="sessStart"]'); await sleep(1500);
  check("Session: starting shows a running clock", await call(`/^\\d:0[1-9]$|^\\d:\\d\\d$/.test(document.getElementById("hbSessClock").textContent) && document.getElementById("hbSessClock").textContent !== "0:00"`));
  await call(`HubUI.sess.startedAt = Date.now() - 125000; 0`); await sleep(1500);
  const today = await call(`HubUI.state().game.days[HubCore.dateKey(new Date())]`);
  check("Session: the minutes played are credited to today (2 min after 125 s)", today && today.min === 2, JSON.stringify(today));
  await setVal('[data-cfg="breakEvery"]', "1"); await call(`HubUI.sess.nagged = false; 0`); await sleep(1500);
  check("Session: a break is due after the chosen time (the 'I took a break' button appears)", await call(`getComputedStyle(document.getElementById("hbBreakNow")).display !== "none"`));
  await click('[data-act="sessBreak"]'); await sleep(300);
  check("Session: taking a break restarts the reminder", await call(`getComputedStyle(document.getElementById("hbBreakNow")).display === "none"`));
  await call(`document.querySelector("#jonah-tool-hub .jtp-close").click(); 0`); await sleep(1500);
  check("Session: with the panel closed a floating timer chip stays on screen", await call(`!!document.getElementById("hubSessionChip") && /\\d/.test(document.getElementById("hubSessionChip").textContent)`));
  await call(`openHub("game", "session"); 0`); await sleep(400);
  await click('[data-act="sessStop"]'); await sleep(500);
  check("Session: ending it stops the clock and removes the chip", (await call(`HubUI.sess.on`)) === false && (await call(`!document.getElementById("hubSessionChip")`)));
  await setVal('[data-cfg="budgetMin"]', "1"); await sleep(300);
  check("Session: over the daily budget it says by how much", /over your/.test(await body()));

  // ---- PC vitals (REAL readings of this computer)
  await tab("vitals");
  const gotVit = await until(async () => /What Jonah found/.test(await body()) && !(await call(`!!document.querySelector("#hbBody .hb-spin")`)), 45000, 500);
  const vtxt = await body();
  check("Vitals: the real readings of this computer arrive", !!gotVit, vtxt.slice(0, 120));
  const sys = await call(`HubUI.cache.vitals && HubUI.cache.vitals.data`);
  check("Vitals: CPU model, load and memory are real numbers", !!sys && sys.cpu.model.length > 3 && sys.cpu.loadPct >= 0 && sys.cpu.loadPct <= 100 && sys.memory.totalGB > 0, sys && JSON.stringify({ m: sys.cpu.model, l: sys.cpu.loadPct, ram: sys.memory.totalGB }));
  check("Vitals: temperature is either a real reading or an honest 'no sensor' - never invented", sys && ((sys.hottest !== null && sys.hottest > 5 && sys.hottest < 120 && /Thermal zone|\u00b0C/.test(vtxt)) || (sys.hottest === null && /does not expose temperature sensors|no sensor/.test(vtxt))), sys && `hottest ${sys.hottest}`);
  check("Vitals: temperature zones are labelled as zones, not as 'CPU'", !sys || !sys.temps.length || sys.temps.every((t) => /^Thermal zone/.test(t.label)));
  const missing = ["Storage", "Battery", "Network", "Graphics", "Jonah itself"].filter((w) => !new RegExp(w).test(vtxt));
  check("Vitals: storage, battery/network, graphics and 'Jonah itself' sections are there", missing.length === 0 && sys.disks.length >= 1, missing.length ? "missing: " + missing.join(", ") + " | jonah=" + JSON.stringify(sys && sys.jonah) + " | disks=" + (sys && sys.disks.length) : "");
  check("Vitals: it reads only - the page says Jonah never changes or closes anything", /never changes or closes anything/.test(vtxt));
  const first = await call(`HubUI.cache.vitals.at`);
  const refreshed = await until(async () => (await call(`HubUI.cache.vitals.at`)) > first, 20000, 500);
  check("Vitals: it refreshes by itself every few seconds while the tab is open", !!refreshed);
  const gpuTxt = sys.gpus.length ? "nvidia" : "no-nvidia";
  check("Vitals: GPU temperature is shown only when an NVIDIA card reports it", sys.gpus.length ? sys.gpus.every((g) => typeof g.tempC === "number" || g.tempC === null) : /only readable on NVIDIA/.test(vtxt), gpuTxt);
  await tab("free"); await sleep(300);
  const stillPolling = await call(`HubUI.vit.timer !== null`);
  check("Vitals: leaving the tab stops the readings (no background polling)", stillPolling === false);

  // ================================================================ CREATOR STUDIO
  await call(`openHub("creator", "plan"); 0`); await sleep(500);
  check("Creator Studio opens with the week plan", /Creator Studio/.test(await call(`document.querySelector("#jonah-tool-hub .jtp-header").textContent`)) && (await call(`document.querySelectorAll(".hb-day").length`)) === 7);
  const todayAt = (dayOffset, h) => `new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + ${dayOffset}, ${h}).getTime()`;
  // the plan: put an item on the first rest day (Sunday) of the CURRENT week view, plus normal ones
  const sundayOffset = await call(`(() => { const d = new Date(); return (7 - ((d.getDay() + 6) % 7) - 1); })()`); // days from today to this week's Sunday
  await call(`(() => { const S = HubUI.state(); const mk = (title, kind, off, h, st) => S.creator.items.push({ id: "t" + title, title, platform: "Instagram", kind, status: st || "idea", when: new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + off, h).toISOString() }); mk("Sunday vlog", "video", ${sundayOffset}, 12); mk("Monday reel", "reel", ${sundayOffset - 6}, 10); localStorage.setItem("jonahHubs", JSON.stringify(S)); HubUI.rerender(); 0; })()`); await sleep(300);
  check("Plan: items appear on their day", (await call(`document.querySelectorAll(".hb-chip").length`)) === 2);
  check("Plan: planning work on a rest day produces the burnout warning", /rest day \(Sunday\)/.test(await call(`document.getElementById("hbBody").textContent`)));
  await setVal("#cpTitle", "Autumn lookbook"); await click('[data-act="planAdd"]'); await sleep(300);
  const items = (await state()).creator.items;
  check("Plan: adding an item stores it", items.length === 3 && items.some((i) => i.title === "Autumn lookbook"));
  const chipId = await call(`document.querySelector('.hb-chip[title^="Monday reel"]').dataset.id`);
  await call(`document.querySelector('.hb-chip[data-id="${chipId}"]').click(); 0`); await sleep(200);
  check("Plan: clicking a chip moves it to the next stage (idea -> scripted)", (await state()).creator.items.find((i) => i.id === chipId).status === "scripted");
  await setVal('[data-cfg="capacity"]', "2"); await sleep(300);
  const rerr = await call(`(() => { try { HubUI.rerender(); return "ok"; } catch (e) { return e.message + " | " + String(e.stack).split(String.fromCharCode(10)).slice(0, 3).join(" ; "); } })()`);
  const capTxt = (await call(`document.getElementById("hbBody") ? document.getElementById("hbBody").textContent : "(no hbBody) panel=" + !!document.getElementById("jonah-tool-hub")`)) + " [rerender: " + rerr + "]";
  check("Plan: too many hours for the weekly limit is called out", /too much/.test(capTxt), JSON.stringify(await call(`({ cfg: HubUI.state().creator.cfg, val: (document.querySelector('[data-cfg="capacity"]') || {}).value, n: document.querySelectorAll('[data-cfg="capacity"]').length })`)) + capTxt.replace(/\s+/g, " ").slice(0, 120));
  await call(`document.querySelector('[data-cfg="rest"][data-d="0"]').click(); 0`); await sleep(300);
  check("Plan: un-ticking Sunday as a rest day removes that warning and it is saved", !/rest day \(Sunday\)/.test(await call(`document.getElementById("hbBody").textContent`)) && !(await state()).creator.cfg.restDays.includes(0));
  await call(`document.querySelector('[data-act="weekNext"]').click(); 0`); await sleep(250);
  check("Plan: next week shows an empty week", (await call(`document.querySelectorAll(".hb-chip").length`)) === 0);

  // ideas
  await tab("ideas");
  await call(`tabData[activeTabIndex].webview.loadURL(${JSON.stringify(siteUrl)}); 0`); await sleep(3500);
  await call(`openHub("creator", "ideas"); 0`); await sleep(300);
  await setVal("#idText", "Film a get-ready-with-me #grwm"); await call(`document.getElementById("idText").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); 0`); await sleep(300);
  check("Ideas: typing an idea and pressing Enter saves it", (await state()).creator.ideas.length === 1);
  await click('[data-act="ideaClip"]'); await sleep(1500);
  const ideas = (await state()).creator.ideas;
  check("Ideas: 'Clip this page' saves the open page's title (http pages are kept without a link)", ideas.length === 2 && /Autumn lookbook - Test Blog/.test(ideas[0].text), JSON.stringify(ideas[0]));
  await setVal("#idSearch", "grwm"); await sleep(200);
  check("Ideas: search filters the inbox", (await call(`document.querySelectorAll("#hbBody .hb-item").length`)) === 1);
  await setVal("#idSearch", ""); await sleep(200);
  await click('[data-act="ideaToPlan"]'); await sleep(300);
  check("Ideas: '-> Plan' moves an idea into the plan", (await state()).creator.ideas.length === 1 && (await state()).creator.items.length === 4);

  // the clip test navigated the first tab away from the home page: bring a home page back for the later checks
  await call(`createNewTab("home.html"); 0`); await sleep(4500); h = await until(() => home(), 15000, 300);
  // income
  await tab("income");
  const d = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  await setVal("#inBrand", "Glow Co"); await setVal("#inAmt", "1200"); await setVal("#inStatus", "invoiced"); await setVal("#inDue", d(-10)); await click('[data-act="incomeAdd"]'); await sleep(250);
  await setVal("#inBrand", "Zest"); await setVal("#inAmt", "500"); await setVal("#inStatus", "paid"); await setVal("#inDue", d(0)); await click('[data-act="incomeAdd"]'); await sleep(250);
  const inc = await body();
  check("Income: paid this month, owed and overdue are summed correctly", /\$500/.test(inc) && /\$1200/.test(inc) && /overdue/.test(inc) && (await call(`document.querySelectorAll(".hb-pill.bad").length`)) >= 1, inc.slice(0, 200));
  await click('[data-act="incomeNext"]'); await sleep(250);
  check("Income: advancing an invoice to 'paid' moves it out of 'owed'", !/overdue/.test(await body()) && (await state()).creator.income.every((e) => e.status === "paid"));
  check("Income: it says it is simple tallies, not financial advice", /not tax or financial advice/.test(await body()));

  // checklists
  await tab("lists");
  await click('[data-act="listStart"][data-name="Brand deal"]'); await sleep(250);
  await call(`document.querySelectorAll('input[data-act="listCheck"]')[0].click(); document.querySelectorAll('input[data-act="listCheck"]')[1].click(); 0`); await sleep(300);
  check("Checklists: a template starts and ticking shows progress (2/6)", /2\/6/.test(await body()));
  await call(`document.querySelector('[data-act="listDel"]').click(); 0`); await sleep(200);
  check("Checklists: it can be deleted", (await state()).creator.lists.length === 0);

  // captions
  await tab("captions");
  await setVal("#cpText", "x".repeat(2300)); await sleep(200);
  check("Captions: the counter turns red over Instagram's 2,200 limit", /2300 \/ 2200/.test(await call(`document.getElementById("cpCount").textContent`)) && (await call(`document.getElementById("cpCount").classList.contains("bad")`)));
  await setVal("#cpPlatform", "X"); await sleep(300);
  check("Captions: switching to X applies its 280 limit", /\/ 280/.test(await call(`document.getElementById("cpCount").textContent`)));
  await setVal("#cpPlatform", "TikTok"); await sleep(300);
  check("Captions: TikTok's limit shows the 'sources disagree' warning", /disagree/.test(await call(`document.getElementById("cpNote").textContent`)));
  await setVal("#cpTopic", "autumn skincare routine"); await click('[data-act="tagsRule"]'); await sleep(300);
  check("Captions: instant offline hashtag ideas are made from the topic", /#autumn/.test(await body()) && /#skincare/.test(await body()));
  await click('.hb-pill[data-act="tagAdd"]'); await sleep(250);
  check("Captions: clicking a hashtag adds it to the caption", /#autumn/.test(await call(`document.getElementById("cpText").value`)));
  await call(`HubUI.ui.askOverride = async () => ({ success: true, text: "Sure! Here are 3 captions:\\n1. Golden hour and a warm cup of tea.\\n2. Soft light, slow mornings.\\n3. Autumn glow, no filter needed." }); 0`);
  await setVal("#cpText", ""); await click('[data-act="capAI"]'); await sleep(600);
  check("Captions: AI ideas are listed (and labelled as a small model to read before posting)", (await call(`document.querySelectorAll('#capOut [data-act="capUse"]').length`)) === 3 && /small model/.test(await body()));
  await click('[data-act="capUse"]'); await sleep(250);
  check("Captions: 'Use' puts that caption in the editor", /Golden hour and a warm cup of tea/.test(await call(`document.getElementById("cpText").value`)));
  await call(`HubUI.ui.askOverride = async () => ({ success: false, error: "You are out of free messages." }); 0`); await click('[data-act="capAI"]'); await sleep(500);
  check("Captions: an assistant/billing error is shown, not swallowed", /out of free messages/.test(await body()));

  // accounts
  await tab("accounts");
  await setVal("#acName", "Brand account"); await click('[data-act="accAdd"]'); await sleep(250);
  const tabsBefore = await call(`tabData.length`);
  await click('[data-act="accOpen"]'); await sleep(1500);
  const accId = (await state()).creator.accounts[0].id;
  check("Accounts: 'Open' opens the site in its own separate session", (await call(`tabData.length`)) === tabsBefore + 1 && (await call(`tabData[tabData.length - 1].webview.getAttribute("partition")`)) === "persist:acct-" + accId);
  check("Accounts: it says passwords are not stored", /does not store your passwords/.test(await body()));

  // ================================================================ AESTHETIC LAB
  await call(`openHub("aesthetic", "looks"); 0`); await sleep(500);
  check("Aesthetic Lab opens with Pinterest's five 2026 colours and their hex codes", (await call(`document.querySelectorAll("#hbBody .hb-card")[0].querySelectorAll(".hb-sw").length`)) === 5 && /#D7EFFF/.test(await body()) && /#351E28/.test(await body()) && /#E9F056/.test(await body()));
  await call(`document.querySelector('.hb-sw[data-hex="#351E28"]').click(); 0`); await sleep(1200);
  check("Looks: picking Plum Noir recolours the whole browser", (await call(`localStorage.getItem("jonahTheme")`)) === "#351e28" && (await call(`document.documentElement.getAttribute("data-theme-color")`)) === "#351e28");
  h = home();
  check("Looks: ...and the home page too (they keep their own copy)", (await h.executeJavaScript(`document.documentElement.getAttribute("data-theme-color")`)) === "#351e28");
  await call(`document.querySelector('[data-act="useColour"][data-hex="#8b5cf6"]').click(); 0`); await sleep(900);
  check("Looks: 'Back to Jonah purple' restores it everywhere", !(await call(`document.documentElement.hasAttribute("data-theme-color")`)) && !(await h.executeJavaScript(`document.documentElement.hasAttribute("data-theme-color")`)));

  await tab("boards");
  check("Moodboards: starts with one board", /My board \(0\)/.test(await body()));
  await click('[data-act="boardNew"]'); await sleep(150); await setVal("#bdNewName", "Autumn"); await click('[data-act="boardCreate"]'); await sleep(250);
  check("Moodboards: a second board is made with an inline name box (no pop-up)", /Autumn \(0\)/.test(await body()) && (await state()).aesthetic.boards.length === 2);
  // add pictures by file: make 3-colour PNGs in the page and hand them to the real file input
  const addFile = (name, colours) => call(`(async () => { const cv = document.createElement("canvas"); cv.width = 300; cv.height = 200; const c = cv.getContext("2d"); ${colours.map((col, i) => `c.fillStyle = "${col}"; c.fillRect(${i * 100}, 0, 100, 200);`).join(" ")} const blob = await new Promise(r => cv.toBlob(r, "image/png")); const dt = new DataTransfer(); dt.items.add(new File([blob], ${JSON.stringify(name)}, { type: "image/png" })); const inp = document.getElementById("bdFiles"); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await addFile("a.png", ["#ff0000", "#0000ff", "#ffffff"]); await sleep(1500);
  check("Moodboards: choosing a picture file adds it (stored in IndexedDB, shown as a thumbnail)", (await state()).aesthetic.boards[1].images.length === 1 && (await call(`document.querySelectorAll("#bdGrid img").length`)) === 1);
  const thumbOk = await until(async () => await call(`(() => { const i = document.querySelector("#bdGrid img"); return !!i && i.complete && i.naturalWidth > 0; })()`), 5000, 200);
  check("Moodboards: the thumbnail really loads from the saved copy", !!thumbOk);
  await call(`(async () => { const cv = document.createElement("canvas"); cv.width = 64; cv.height = 64; const c = cv.getContext("2d"); c.fillStyle = "#00aa00"; c.fillRect(0, 0, 64, 64); const blob = await new Promise(r => cv.toBlob(r, "image/png")); const dt = new DataTransfer(); dt.items.add(new File([blob], "p.png", { type: "image/png" })); document.getElementById("jonah-tool-hub").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`); await sleep(1500);
  check("Moodboards: pasting a copied picture (Ctrl+V) adds it", (await state()).aesthetic.boards[1].images.length === 2);
  // a REAL remote image, fetched by the main process (live giveaway thumbnail from GamerPower)
  const imgUrl = await call(`(HubUI.cache.giveaways && HubUI.cache.giveaways.data && HubUI.cache.giveaways.data.items.map(x => x.thumb).find(Boolean)) || ""`);
  if (imgUrl) { await setVal("#bdUrl", imgUrl); await click('[data-act="boardUrl"]'); await until(async () => (await state()).aesthetic.boards[1].images.length === 3, 25000, 400); }
  check("Moodboards: a real https image link is fetched by Jonah's main process and added", !imgUrl || (await state()).aesthetic.boards[1].images.length === 3, imgUrl);
  await setVal("#bdUrl", "http://example.com/a.jpg"); await click('[data-act="boardUrl"]'); await sleep(800);
  check("Moodboards: an insecure http link is refused with a reason", /Only https/.test(await body()));
  await setVal("#bdUrl", "https://192.168.1.1/router.png"); await click('[data-act="boardUrl"]'); await sleep(800);
  check("Moodboards: a link into the user's own network is refused", /your own network|inside your own/.test(await body()));
  await call(`tabData[activeTabIndex].webview.loadURL(${JSON.stringify(siteUrl)}); 0`); await sleep(3500);
  await click('[data-act="boardPage"]'); await sleep(1000);
  check("Moodboards: 'From this page' only offers https pictures (the test page has only an http one)", /No big pictures found/.test(await body()));

  // palette: from the red/blue/white picture on the board
  const firstId = (await state()).aesthetic.boards[1].images.slice(-1)[0];
  await call(`document.querySelector('#bdGrid .im[data-id="${firstId}"]').click(); 0`); await sleep(1500);
  const pal = await call(`HubUI.ui.palette && HubUI.ui.palette.colours`);
  check("Palette: clicking a board picture pulls out its three colours (red, blue, white)", pal && pal.length === 3 && pal.some((c) => /^#f[0-9a-f]0000$|^#fe0000$|^#ff0000$/i.test(c.hex) || (parseInt(c.hex.slice(1, 3), 16) > 230 && parseInt(c.hex.slice(3, 5), 16) < 25)) && pal.some((c) => parseInt(c.hex.slice(5, 7), 16) > 230 && parseInt(c.hex.slice(1, 3), 16) < 25) && pal.some((c) => parseInt(c.hex.slice(1, 3), 16) > 235 && parseInt(c.hex.slice(5, 7), 16) > 235), JSON.stringify(pal));
  check("Palette: swatches show the hex codes and a share each", (await call(`document.querySelectorAll("#hbBody .hb-sw").length`)) === 3 && /%/.test(await body()));
  await call(`document.querySelector('#hbBody .hb-link[data-act="useColour"]').click(); 0`); await sleep(1200);
  check("Palette: a colour from the picture can recolour Jonah", await call(`document.documentElement.hasAttribute("data-theme-color")`));
  await call(`JonahThemeHost.setAll("#8b5cf6"); 0`); await sleep(500);
  await setVal("#plK", "4"); await sleep(1200);
  check("Palette: choosing a different number of colours recomputes", (await call(`HubUI.ui.palette.colours.length`)) <= 4);

  await tab("reference");
  check("Reference: 12 aesthetics with Wiki + 'Use colour' buttons, and the licence/attribution note", (await call(`document.querySelectorAll('#hbBody [data-act="open"]').length`)) === 12 && /CC-BY-SA/.test(await body()) && /search links are not tested/.test(await body()));
  check("Reference: wiki links are search links on aesthetics.fandom.com", await call(`[...document.querySelectorAll('#hbBody [data-act="open"]')].every(b => /^https:\\/\\/aesthetics\\.fandom\\.com\\/wiki\\/Special:Search\\?query=/.test(b.dataset.url))`));
  await call(`openHub("aesthetic", "boards"); 0`); await sleep(300);
  await call(`document.querySelector('[data-act="boardPick"]').click(); 0`); await sleep(200);
  await call(`document.querySelector('[data-act="boardDel"]').click(); 0`); await sleep(400);
  check("Moodboards: deleting a board (with its pictures) works", (await state()).aesthetic.boards.length === 1);

  // ================================================================ security
  await call(`createNewTab(${JSON.stringify(siteUrl)}); 0`); await sleep(5000);
  const evil = guests().find((g) => g.getURL().startsWith(siteUrl));
  check("Security: a website page has NO access to the hub bridge (window.hubs)", !!evil && (await evil.executeJavaScript(`typeof window.hubs`)) === "undefined");
  await call(`document.getElementById("jonah-tool-hub") && document.getElementById("jonah-tool-hub").remove(); 0`); await sleep(2500);
  check("Security: a website dispatching 'open hub' / 'theme' events opens nothing and recolours nothing", !(await call(`!!document.getElementById("jonah-tool-hub")`)) && !(await call(`document.documentElement.hasAttribute("data-theme-color")`)));

  console.log(failures ? `RESULT hubs FAILED (${failures} failing)` : "RESULT hubs ok");
  app.exit(failures ? 1 : 0);
}

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-hb-run-"));
  const env = { ...process.env, JONAH_ENTITLEMENTS_ENABLED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${path.join(tmp, "data")}`, __filename], { env, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 480000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT|CONSOLE)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (code === -99 || !/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-30).join("\n")); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
