"use strict";

// A guided view of existing preferences. No credentials, library data or drafts are persisted here.
const FIRST_SETUP_KEY = "tagcast-first-setup-v1";
const FIRST_SETUP_STEPS = ["setup.welcome", "setup.playback", "setup.lyrics", "setup.workspace", "setup.extras", "setup.summary"];
const firstSetup = {initialized: false, statusReady: false, eligible: false, progress: null, step: 0, drafts: new Map(), baselines: new Map(), saving: false, connecting: false, scope: "", focus: null, error: null};
function firstSetupScope() { return JSON.stringify([state.connection.connected, state.connection.account, state.connection.playback_session, state.connection.premium === true]); }
function readFirstSetup() {
  try {
    const value = JSON.parse(localStorage.getItem(FIRST_SETUP_KEY));
    return value?.version === 1 && ["active", "paused", "done"].includes(value.status)
      && Number.isInteger(value.step) && value.step >= 0 && value.step < FIRST_SETUP_STEPS.length ? value : null;
  } catch { return null; }
}
function rememberFirstSetup(status) {
  firstSetup.progress = {version: 1, status, step: firstSetup.step};
  try { localStorage.setItem(FIRST_SETUP_KEY, JSON.stringify(firstSetup.progress)); } catch { /* Optional profile storage. */ }
}
function initializeFirstSetup(data) {
  if (firstSetup.initialized) return;
  firstSetup.initialized = true; firstSetup.progress = readFirstSetup();
  firstSetup.eligible = data.setup_eligible === true;
  maybeOpenFirstSetup();
}
function firstSetupBootReady() { firstSetup.statusReady = true; maybeOpenFirstSetup(); }
function maybeOpenFirstSetup() {
  // Both startup responses must settle before capturing account-bound defaults.
  // Never reinterpret a later outage/disconnect as a new installation.
  if (firstSetup.initialized && firstSetup.statusReady && (firstSetup.progress?.status === "active" || (!firstSetup.progress && firstSetup.eligible))) openFirstSetup(true);
}
function firstSetupSettings() {
  return `<section data-settings-category="interface"><h3>${TagcastI18n.html("setup.title")}</h3><p class="muted">${TagcastI18n.html("setup.settingsNote")}</p><button type="button" class="button" data-first-setup>${TagcastI18n.html("setup.open")}</button></section>`;
}
function firstSetupCurrent(step) {
  if (step === 1) return {quality: lookup.streamQuality, gapless: gaplessTrial.enabled};
  if (step === 2) return {lyrics: playbackLyricsView.mode};
  if (step === 3) return {language: TagcastI18n.choice || "auto", appearance: document.documentElement.dataset.theme || "auto", palette: "keep", browsing: "keep", view: visualPlayerMode};
  if (step === 4) return {record: lookup.recordPlays, sync: lookup.queueSync};
  return {};
}
function firstSetupDraft() {
  if (!firstSetup.drafts.has(firstSetup.step)) {
    const values = firstSetupCurrent(firstSetup.step);
    firstSetup.baselines.set(firstSetup.step, structuredClone(values)); firstSetup.drafts.set(firstSetup.step, values);
  }
  return firstSetup.drafts.get(firstSetup.step);
}
function setupLabel(key) { return `<span data-i18n="${key}">${TagcastI18n.html(key)}</span>`; }
function setupSelect(id, key, choices, value) {
  return `<label class="field">${setupLabel(key)}<select id="setup-${id}">${choices.map(([v, text]) => `<option value="${v}" ${value === v ? "selected" : ""}>${TagcastI18n.html(text)}</option>`).join("")}</select></label>`;
}
function firstSetupStepMarkup() {
  const d = firstSetupDraft(), connected = state.connection.connected, premium = connected && state.connection.premium === true;
  if (firstSetup.step === 0) return `<p>${setupLabel("setup.welcomeNote")}</p><p class="muted">${setupLabel(connected ? "connection.connected.note" : "connection.ready.registered")}</p>
    <button type="button" class="button primary" data-setup-connect>${setupLabel(connected ? "setup.continue" : "connection.ready.signIn")}</button>
    ${connected ? "" : `<button type="button" class="button" data-setup-demo>${setupLabel("setup.demo")}</button>`}`;
  if (firstSetup.step === 1) return `${premium ? `<label class="field">${setupLabel("settings.streaming.quality")}<select id="setup-quality">${["96", "128", "192", "256", "320", "orig"].map(value => `<option value="${value}" ${d.quality === value ? "selected" : ""}>${value === "orig" ? TagcastI18n.html("settings.streaming.original") : TagcastI18n.html("settings.streaming.mp3", {quality: value})}</option>`).join("")}</select></label>` : `<p>${setupLabel(connected ? "settings.streaming.freeQuality" : "setup.connectQuality")}</p>`}
    <p class="muted">${setupLabel("settings.streaming.note")}</p><label class="checkline"><input id="setup-gapless" type="checkbox" ${d.gapless ? "checked" : ""} ${gaplessSupported() ? "" : "disabled"}>${setupLabel("gapless.settings.enable")}</label><p class="muted">${setupLabel("gapless.settings.intro")}</p>`;
  if (firstSetup.step === 2) return setupSelect("lyrics", "playbackLyrics.settings.source", [["native", "playbackLyrics.settings.native"], ["native-first", "playbackLyrics.settings.nativeFirst"], ["unison-first", "playbackLyrics.settings.unisonFirst"]], d.lyrics)
    + `<p class="muted">${setupLabel("playbackLyrics.settings.online")}</p><p class="muted">${setupLabel("playbackLyrics.settings.timing")}</p>`;
  if (firstSetup.step === 3) return `<label class="field">${setupLabel("settings.language.label")}<select id="setup-language"><option value="auto" ${d.language === "auto" ? "selected" : ""}>${TagcastI18n.html("page.language.automatic")}</option>${TagcastI18n.languages().map(l => `<option value="${l.tag}" ${d.language === l.tag ? "selected" : ""}>${escapeHtml(l.name)}</option>`).join("")}</select></label>`
    + setupSelect("appearance", "page.theme.appearance", [["auto", "page.theme.auto"], ["light", "page.theme.light"], ["dark", "page.theme.dark"]], d.appearance)
    + `<label class="field">${setupLabel("page.theme.colour")}<select id="setup-palette"><option value="keep">${TagcastI18n.html("setup.keepTheme")}</option>${TagcastThemes.builtins.map(p => `<option value="${p}" ${d.palette === p ? "selected" : ""}>${escapeHtml(themePaletteLabel(p))}</option>`).join("")}</select></label>`
    + setupSelect("browsing", "continuous.display", [["keep", "setup.keepBrowsing"], ["continuous", "continuous.mode"], ["pages", "setup.pages"]], d.browsing)
    + setupSelect("view", "settings.display.view", [["fullscreen", "settings.display.fullscreen"], ["window", "settings.display.window"]], d.view);
  if (firstSetup.step === 4) return `<label class="checkline"><input id="setup-record" type="checkbox" ${d.record ? "checked" : ""}>${setupLabel("settings.streaming.recordPlays")}</label><p class="muted">${setupLabel("settings.streaming.recordNote")}</p><label class="checkline"><input id="setup-sync" type="checkbox" ${d.sync ? "checked" : ""}>${setupLabel("settings.devices.enable")}</label><p class="muted">${setupLabel("settings.devices.note")}</p><p class="muted">${setupLabel("setup.extrasNote")}</p>`;
  const lyrics = {native: "playbackLyrics.settings.native", "native-first": "playbackLyrics.settings.nativeFirst", "unison-first": "playbackLyrics.settings.unisonFirst"};
  return `<p>${setupLabel("setup.finishedNote")}</p><dl class="setup-summary"><dt>${TagcastI18n.html("settings.streaming.quality")}</dt><dd>${lookup.streamQuality === "orig" ? TagcastI18n.html("settings.streaming.original") : TagcastI18n.html("settings.streaming.mp3", {quality: connected && !premium ? "128" : lookup.streamQuality})}</dd><dt>${TagcastI18n.html("playbackLyrics.settings.source")}</dt><dd>${TagcastI18n.html(lyrics[playbackLyricsView.mode])}</dd><dt>${TagcastI18n.html("settings.streaming.recordPlays")}</dt><dd>${TagcastI18n.html(lookup.recordPlays ? "setup.on" : "setup.off")}</dd><dt>${TagcastI18n.html("settings.devices.enable")}</dt><dd>${TagcastI18n.html(lookup.queueSync ? "setup.on" : "setup.off")}</dd></dl><button type="button" class="button" data-setup-settings>${setupLabel("setup.allSettings")}</button>`;
}
function renderFirstSetup() {
  firstSetup.error = null;
  $("#first-setup-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">${TagcastI18n.html("setup.title")}</div><h2 id="first-setup-title" tabindex="-1">${TagcastI18n.html(FIRST_SETUP_STEPS[firstSetup.step])}</h2></div><button type="button" class="close" data-setup-pause aria-label="${TagcastI18n.html("setup.later")}">×</button></div><ol class="setup-progress" aria-label="${TagcastI18n.html("setup.progress")}">${FIRST_SETUP_STEPS.map((key, i) => `<li ${i === firstSetup.step ? 'aria-current="step"' : ""}>${TagcastI18n.html(key)}</li>`).join("")}</ol><div id="first-setup-fields">${firstSetupStepMarkup()}</div><p id="first-setup-error" class="error-text" role="status" aria-live="polite"></p><div class="dialog-footer"><button type="button" class="button" data-setup-back ${firstSetup.step === 0 ? "disabled" : ""}>${setupLabel("setup.back")}</button><button type="button" class="text-action" data-setup-pause>${setupLabel("setup.later")}</button>${firstSetup.step > 0 && firstSetup.step < 5 ? `<button type="button" class="button" data-setup-skip>${setupLabel("setup.skip")}</button>` : ""}${firstSetup.step > 0 ? `<button type="button" class="button primary" data-setup-next>${setupLabel(firstSetup.step === 5 ? "setup.finish" : "setup.saveContinue")}</button>` : ""}</div>`;
  $("#first-setup-title").focus({preventScroll: true});
}
function openFirstSetup(automatic = false) {
  if (firstSetup.saving || $("#first-setup").open) return;
  if (settingsView.dirty || settingsView.saving || themeEditorDirty() || document.querySelector("dialog[open]")) {
    if (!automatic) toast(TagcastI18n.text("setup.existingDraft"));
    return;
  }
  firstSetup.focus = document.activeElement;
  const scope = firstSetupScope();
  if (scope !== firstSetup.scope) { firstSetup.drafts.clear(); firstSetup.baselines.clear(); }
  firstSetup.scope = scope; firstSetup.progress ||= readFirstSetup();
  firstSetup.step = firstSetup.progress && firstSetup.progress.status !== "done" ? firstSetup.progress.step : 0;
  rememberFirstSetup("active"); renderFirstSetup(); $("#first-setup").showModal();
  $("#first-setup-title").focus({preventScroll: true});
}
function captureFirstSetup() {
  const d = firstSetupDraft(), value = id => $("#setup-" + id).value, checked = id => $("#setup-" + id).checked;
  if (firstSetup.step === 1) { if (state.connection.connected && state.connection.premium) d.quality = $("#setup-quality")?.value ?? d.quality; if (gaplessSupported()) d.gapless = checked("gapless"); }
  if (firstSetup.step === 2) d.lyrics = value("lyrics");
  if (firstSetup.step === 3) for (const key of ["language", "appearance", "palette", "browsing", "view"]) d[key] = value(key);
  if (firstSetup.step === 4) { d.record = checked("record"); d.sync = checked("sync"); }
  return d;
}
function firstSetupAdvance(step) { firstSetup.step = step; rememberFirstSetup("active"); renderFirstSetup(); }
function pauseFirstSetup(done = false) {
  if (firstSetup.saving) return;
  captureFirstSetup(); rememberFirstSetup(done ? "done" : "paused"); $("#first-setup").close();
  if (firstSetup.focus?.isConnected) firstSetup.focus.focus({preventScroll: true});
}
async function saveFirstSetup() {
  if (firstSetup.saving) return;
  if (firstSetup.step === 5) { pauseFirstSetup(true); return; }
  const step = firstSetup.step, draft = captureFirstSetup(), baseline = firstSetup.baselines.get(step);
  const locked = [...$("#first-setup").querySelectorAll("button,input,select")].map(node => [node, node.disabled]);
  firstSetup.saving = true; locked.forEach(([node]) => { node.disabled = true; });
  try {
    if (firstSetup.scope !== firstSetupScope() || JSON.stringify(firstSetupCurrent(step)) !== JSON.stringify(baseline)) throw Error(TagcastI18n.text("setup.changed"));
    if (step === 1) {
      if (!["96", "128", "192", "256", "320", "orig"].includes(draft.quality)) throw Error(TagcastI18n.text("setup.invalid"));
      if (draft.quality !== baseline.quality && state.connection.premium !== true) throw Error(TagcastI18n.text("setup.changed"));
      if (draft.quality !== baseline.quality) await persistSettings({stream_quality: draft.quality});
      if (firstSetup.scope !== firstSetupScope()) throw Error(TagcastI18n.text("setup.changed"));
      if (draft.gapless !== baseline.gapless) setGaplessEnabled(draft.gapless);
    } else if (step === 2) {
      if (!["native", "native-first", "unison-first"].includes(draft.lyrics)) throw Error(TagcastI18n.text("setup.invalid"));
      if (draft.lyrics !== baseline.lyrics) setPlaybackLyricsMode(draft.lyrics);
    } else if (step === 3) {
      if (!["auto", ...TagcastI18n.languages().map(l => l.tag)].includes(draft.language) || !["auto", "light", "dark"].includes(draft.appearance) || !["keep", ...TagcastThemes.builtins].includes(draft.palette) || !["keep", "pages", "continuous"].includes(draft.browsing) || !["window", "fullscreen"].includes(draft.view)) throw Error(TagcastI18n.text("setup.invalid"));
      if (draft.language !== baseline.language) {
        await chooseInterfaceLanguage(draft.language);
        if (interfaceLanguage.statusKey === "settings.language.saveFailed") {
          await TagcastI18n.use(baseline.language);
          throw Error(interfaceLanguage.status);
        }
        if (firstSetup.scope !== firstSetupScope()) throw Error(TagcastI18n.text("setup.changed"));
      }
      if (draft.appearance !== baseline.appearance) setColourAppearance(draft.appearance);
      if (draft.palette !== "keep") { const palette = setColourPalette(draft.palette); try { localStorage.setItem("tagcast-palette", palette); } catch { /* Optional storage. */ } }
      if (draft.browsing !== "keep") { albumContinuous.setEnabled(draft.browsing === "continuous"); artistContinuous.setEnabled(draft.browsing === "continuous");
        if (state.screen === "albums") render();
        else if (state.screen === "artists") renderArtistBrowse();
      }
      if (draft.view !== baseline.view) setVisualPlayerMode(draft.view);
    } else if (step === 4) {
      const body = {};
      if (draft.record !== baseline.record) body.record_plays = draft.record;
      if (draft.sync !== baseline.sync) body.queue_sync = draft.sync;
      if (Object.keys(body).length) await persistSettings(body);
    }
    if (firstSetup.scope !== firstSetupScope()) throw Error(TagcastI18n.text("setup.changed"));
    firstSetup.drafts.delete(step); firstSetup.baselines.delete(step);
    settingsView.rendered = false;
    firstSetupAdvance(step + 1);
  } catch (error) {
    firstSetup.error = () => TagcastI18n.errorText(error); $("#first-setup-error").textContent = firstSetup.error();
  } finally { firstSetup.saving = false; locked.forEach(([node, disabled]) => { if (node.isConnected) node.disabled = disabled; }); }
}
$("#first-setup").addEventListener("cancel", event => { event.preventDefault(); pauseFirstSetup(); });
$("#connect").addEventListener("close", () => {
  if (!firstSetup.connecting) return;
  firstSetup.connecting = false;
  if ($("#first-setup").open && state.connection.connected) {
    firstSetup.scope = firstSetupScope(); firstSetup.drafts.clear(); firstSetup.baselines.clear(); firstSetupAdvance(1);
  }
});
document.addEventListener("click", event => {
  const target = event.target;
  if (target.closest("[data-first-setup]")) openFirstSetup();
  if (!target.closest("#first-setup")) return;
  if (target.closest("[data-setup-pause]")) pauseFirstSetup();
  if (firstSetup.saving) return;
  if (target.closest("[data-setup-connect]")) { if (state.connection.connected) firstSetupAdvance(1); else { firstSetup.connecting = true; openConnect(); } }
  if (target.closest("[data-setup-demo]")) firstSetupAdvance(1);
  if (target.closest("[data-setup-back]")) { captureFirstSetup(); firstSetupAdvance(Math.max(0, firstSetup.step - 1)); }
  if (target.closest("[data-setup-skip]")) { firstSetup.drafts.delete(firstSetup.step); firstSetup.baselines.delete(firstSetup.step); firstSetupAdvance(firstSetup.step + 1); }
  if (target.closest("[data-setup-next]")) saveFirstSetup();
  if (target.closest("[data-setup-settings]")) { pauseFirstSetup(true); openSettings("interface"); }
});
TagcastI18n.subscribe(() => {
  // Never rebuild inputs/drafts for a language change.
  if (firstSetup.error && $("#first-setup").open) $("#first-setup-error").textContent = firstSetup.error();
});
window.addEventListener("beforeunload", event => { if (firstSetup.saving) { event.preventDefault(); event.returnValue = ""; } });
