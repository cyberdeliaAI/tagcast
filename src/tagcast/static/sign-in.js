// One provider window around the existing device flow. Tokens remain server-side.
// `message` is the interface text key of the current step, translated when shown.
const signInFlow = {serial: 0, requestId: "", popup: null, opening: false, message: ""};
let signInPollGeneration = 0;

function signInVerificationUrl(device) {
  for (const value of [device?.verification_uri_complete, device?.verification_uri]) {
    if (typeof value !== "string" || value.length > 8192) continue;
    try {
      const url = new URL(value);
      if (url.origin === "https://oauth.ibroadcast.com" && !url.username && !url.password) return url.href;
    } catch { /* an invalid provider response keeps the manual code available */ }
  }
  return "https://oauth.ibroadcast.com/device";
}

function signInDesktop() { return typeof window.tagcastSignIn?.open === "function"; }

function reserveSignInPopup() {
  if (signInDesktop()) return null;
  try {
    // Reserve synchronously in the click handler, before requesting a device code.
    const popup = window.open("about:blank", "_blank", "popup,width=620,height=800,resizable=yes,scrollbars=yes");
    if (popup) {
      popup.opener = null;
      popup.document.title = TagcastI18n.text("signIn.popup.title");
      popup.document.body.textContent = TagcastI18n.text("signIn.popup.opening");
    }
    return popup;
  } catch { return null; }
}

function closeSignInChild() {
  if (signInFlow.requestId && signInDesktop()) window.tagcastSignIn.close(signInFlow.requestId);
  try { signInFlow.popup?.close(); } catch { /* a browser may already have closed it */ }
  signInFlow.popup = null; signInFlow.opening = false;
}

async function openSignInChild(device, serial, reserved = null) {
  if (serial !== signInFlow.serial) { try { reserved?.close(); } catch {} return; }
  signInFlow.requestId = device.request_id || "";
  let opened = false;
  if (signInDesktop() && signInFlow.requestId) {
    try { opened = await window.tagcastSignIn.open(signInFlow.requestId) === true; } catch { /* code/browser fallback */ }
  } else if (!signInDesktop()) {
    signInFlow.popup = reserved;
    try {
      if (reserved && !reserved.closed) { reserved.location.replace(signInVerificationUrl(device)); opened = true; }
    } catch { try { reserved?.close(); } catch {} signInFlow.popup = null; }
  }
  if (serial !== signInFlow.serial) return;
  signInFlow.opening = false;
  signInFlow.message = opened ? "signIn.device.opened" : "signIn.device.blocked";
  connectView("device", {device, fallback: !opened});
}

async function beginSignIn(target) {
  if (signInFlow.opening) return;
  const reserved = reserveSignInPopup(), serial = ++signInFlow.serial;
  closeSignInChild(); signInFlow.popup = reserved; signInFlow.opening = true; signInFlow.message = "";
  target.disabled = true;
  try {
    const {device} = await api("/api/auth/device", {});
    if (serial !== signInFlow.serial) {
      try { reserved?.close(); } catch {}
      if (device.request_id) api("/api/auth/cancel", {request_id: device.request_id}).catch(() => {});
      return;
    }
    state.connection.device = device;
    connectView("device", {device}); pollDevice();
    await openSignInChild(device, serial, reserved);
  } catch (error) {
    try { reserved?.close(); } catch {}
    if (serial !== signInFlow.serial) return;
    signInFlow.opening = false;
    connectView("ready", {error: TagcastI18n.errorText(error)});
  }
}

async function reopenSignIn() {
  const device = state.connection.device;
  if (device?.state !== "pending" || signInFlow.opening) return;
  if (!signInDesktop() && signInFlow.popup && !signInFlow.popup.closed) {
    try { signInFlow.popup.focus(); return; } catch { /* reopen below */ }
  }
  const reserved = reserveSignInPopup(), serial = ++signInFlow.serial;
  signInFlow.opening = true;
  await openSignInChild(device, serial, reserved);
}

async function cancelSignIn(render = true) {
  const id = signInFlow.requestId || state.connection.device?.request_id;
  const serial = ++signInFlow.serial;
  stopPoll(); closeSignInChild(); signInFlow.requestId = "";
  // A start still in flight cleans up its own bound request when it returns.
  if (!id && state.connection.device?.state !== "pending") { if (render) connectView("ready"); return; }
  try {
    await api("/api/auth/cancel", id ? {request_id: id} : {});
    if (serial !== signInFlow.serial) return;
    state.connection.device = null;
    pollDevice(0); // approval may already have completed; never revoke it
  } catch (error) {
    if (serial !== signInFlow.serial || !render) return;
    signInFlow.requestId = id;
    connectView("device", {device: state.connection.device, error: TagcastI18n.errorText(error), fallback: true});
    pollDevice();
  }
}

// Every label carries data-i18n, so an open sign-in step follows a language change
// without being rebuilt (the code, the approval and the provider window stay as they are).
function signInDeviceMarkup(device, {error = "", fallback = false} = {}) {
  const link = signInVerificationUrl(device), message = signInFlow.message || "signIn.device.opening";
  return `<div class="connect-step"><p class="muted" data-i18n="${message}">${TagcastI18n.html(message)}</p><p class="muted" data-i18n="signIn.device.waiting"><span class="spinner"></span>${TagcastI18n.html("signIn.device.waiting")}</p>${error}<details ${fallback ? "open" : ""}><summary data-i18n="signIn.device.useCode">${TagcastI18n.html("signIn.device.useCode")}</summary><p class="muted" data-i18n="signIn.device.enterCode">${TagcastI18n.html("signIn.device.enterCode")}</p><div class="device-code">${escapeHtml(device?.user_code || "")}</div><p><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" data-i18n="signIn.device.openBrowser">${TagcastI18n.html("signIn.device.openBrowser")}</a></p></details></div><div class="dialog-footer"><button class="button" id="device-cancel" data-i18n="common.cancel">${TagcastI18n.html("common.cancel")}</button><button class="button primary" id="device-open" data-i18n="signIn.device.openWindow">${TagcastI18n.html("signIn.device.openWindow")}</button></div>`;
}

function finishSignIn(status) {
  ++signInFlow.serial; stopPoll(); closeSignInChild(); signInFlow.requestId = "";
  state.connection = status;
  $("#connect").close(); toast(TagcastI18n.text("signIn.connected")); updateChrome(); loadLive();
}

if (typeof window.tagcastSignIn?.onClosed === "function") window.tagcastSignIn.onClosed(event => {
  if (event?.requestId !== signInFlow.requestId) return;
  if (["load-failed", "browser-needed"].includes(event.reason)) {
    signInFlow.opening = false;
    signInFlow.message = event.reason === "browser-needed" ? "signIn.device.browserNeeded" : "signIn.device.loadFailed";
    if ($("#connect").open) connectView("device", {device: state.connection.device, fallback: true});
  } else {
    // The native window performs its own bound cancellation, including on reload.
    ++signInFlow.serial; signInFlow.opening = false; signInFlow.requestId = "";
    pollDevice(0);
  }
});

$("#connect").addEventListener("close", () => {
  if (signInFlow.opening || state.connection.device?.state === "pending") cancelSignIn(false);
});
window.addEventListener("pagehide", () => {
  if (signInDesktop()) return; // the main process owns native window cleanup
  closeSignInChild();
  if (signInFlow.requestId) fetch("/api/auth/cancel", {method: "POST", keepalive: true,
    headers: {"X-Tagcast": "1", "Content-Type": "application/json"},
    body: JSON.stringify({request_id: signInFlow.requestId})}).catch(() => {});
});
