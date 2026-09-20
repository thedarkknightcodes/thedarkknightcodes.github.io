// Phase 0 connection-test page. This file is written to be lifted almost
// unchanged into the real app's app.js later — the api() function in
// particular is meant to be the final shape of "how we talk to the server".

const DEVICE_KEY_STORAGE_KEY = "planner.deviceKey";
const API_MODE_STORAGE_KEY = "planner.api";
const PLACEHOLDER_URL = "PASTE_PROD_EXEC_URL_HERE";

// --- localStorage helpers -----------------------------------------------
// Every localStorage call is wrapped in try/catch. Private browsing modes,
// locked-down browsers, or a full storage quota can all make localStorage
// throw instead of just failing quietly — we don't want that to crash the
// page.

function loadDeviceKey() {
  try {
    return localStorage.getItem(DEVICE_KEY_STORAGE_KEY) || "";
  } catch (err) {
    return "";
  }
}

function saveDeviceKey(key) {
  try {
    localStorage.setItem(DEVICE_KEY_STORAGE_KEY, key);
    return true;
  } catch (err) {
    return false;
  }
}

function forgetDeviceKey() {
  try {
    localStorage.removeItem(DEVICE_KEY_STORAGE_KEY);
  } catch (err) {
    // Nothing more we can do — worst case the key stays in storage.
  }
}

function loadApiModePreference() {
  try {
    return localStorage.getItem(API_MODE_STORAGE_KEY) || "";
  } catch (err) {
    return "";
  }
}

// --- Which server URL to use ---------------------------------------------
// `?api=staging` in the address bar wins if present; otherwise a saved
// localStorage preference; otherwise we default to prod.

function pickApiUrl() {
  const config = window.PLANNER_CONFIG || {};
  const params = new URLSearchParams(window.location.search);
  const queryMode = params.get("api");
  const mode = queryMode || loadApiModePreference();

  if (mode === "staging") {
    return { url: config.stagingUrl || "", mode: "staging" };
  }
  return { url: config.prodUrl || "", mode: "prod" };
}

// --- The API helper --------------------------------------------------------
// This is the function meant to be reused as-is in the real app later.
//
// Notes on the fetch options, because they matter and are easy to get wrong:
//  - method/headers/body: a POST with Content-Type "text/plain" and a JSON
//    string body counts as a CORS "simple request", so the browser does not
//    need to do an OPTIONS preflight first — which matters because Apps
//    Script Web Apps can't answer a preflight the way a normal API would.
//  - we deliberately do NOT use mode: "no-cors". no-cors would let the
//    request go out, but the browser refuses to let our JS read the
//    response at all — so we'd never know if the save actually worked. That
//    was the old app's bug: it always showed "Synced" even when the server
//    rejected the request.
//  - redirect: "follow" — Apps Script Web Apps respond with a redirect to
//    the actual result; fetch needs to follow it to get the real JSON back.
async function api(action, payload) {
  const target = pickApiUrl();

  if (!target.url || target.url === PLACEHOLDER_URL) {
    throw new ConfigError(
      "config.js not filled in yet — paste your Apps Script /exec URL into " +
      (target.mode === "staging" ? "stagingUrl" : "prodUrl") + "."
    );
  }

  const token = loadDeviceKey();
  const body = Object.assign({ token: token, action: action }, payload || {});

  const started = performance.now();
  let response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      redirect: "follow",
      mode: "cors",
    });
  } catch (err) {
    // A network-level failure (offline, DNS failure, the script itself
    // crashing before it could send a response, CORS rejection, etc). We
    // can't tell these apart from JS, so the message stays generic.
    throw new NetworkError("Couldn't reach the server (offline, or the script crashed).");
  }
  const elapsedMs = Math.round(performance.now() - started);

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new NetworkError("Server responded, but not with valid JSON.");
  }

  if (!data || data.ok !== true) {
    const code = data && data.error ? data.error : "unknown_error";
    throw new ApiError(code);
  }

  return { data: data, elapsedMs: elapsedMs };
}

function ConfigError(message) {
  this.name = "ConfigError";
  this.message = message;
}
ConfigError.prototype = Object.create(Error.prototype);

function NetworkError(message) {
  this.name = "NetworkError";
  this.message = message;
}
NetworkError.prototype = Object.create(Error.prototype);

function ApiError(code) {
  this.name = "ApiError";
  this.code = code;
  this.message = "Server said: " + code;
}
ApiError.prototype = Object.create(Error.prototype);

// --- Page wiring -----------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

function showResult(text) {
  el("result").textContent = text;
}

function refreshKeyUi() {
  const hasKey = !!loadDeviceKey();
  el("hidden-when-saved").classList.toggle("is-hidden", hasKey);
  el("shown-when-saved").classList.toggle("is-hidden", !hasKey);
}

function refreshConfigWarning() {
  const target = pickApiUrl();
  const warningSection = el("config-warning");
  if (!target.url || target.url === PLACEHOLDER_URL) {
    el("config-warning-text").textContent =
      "config.js not filled in yet — paste your Apps Script /exec URL into config.js.";
    warningSection.classList.remove("is-hidden");
  } else {
    warningSection.classList.add("is-hidden");
  }
  el("api-target").textContent = "Target: " + target.mode + (target.url ? "" : " (not set)");
}

function handleSaveKey() {
  const value = el("device-key-input").value.trim();
  if (!value) return;
  saveDeviceKey(value);
  el("device-key-input").value = ""; // never leave the key sitting in the field
  refreshKeyUi();
}

function handleForgetKey() {
  forgetDeviceKey();
  refreshKeyUi();
}

async function handlePing() {
  showResult("Pinging...");
  try {
    const { data, elapsedMs } = await api("ping", {});
    showResult(
      "Ping OK (" + elapsedMs + "ms)\n" +
      "Version: " + data.version + "\n" +
      "Server time: " + data.time + "\n" +
      "Timezone: " + data.tz
    );
  } catch (err) {
    showResult(describeError(err));
  }
}

async function handleList() {
  showResult("Loading tasks...");
  try {
    const { data, elapsedMs } = await api("list", {});
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const firstFive = tasks.slice(0, 5).map(function (t) {
      return "- " + (t.task || "(untitled)");
    });
    showResult(
      "List OK (" + elapsedMs + "ms)\n" +
      "Task count: " + tasks.length + "\n" +
      (firstFive.length ? "First tasks:\n" + firstFive.join("\n") : "(no tasks)")
    );
  } catch (err) {
    showResult(describeError(err));
  }
}

function describeError(err) {
  if (err instanceof ConfigError) return err.message;
  if (err instanceof NetworkError) return err.message;
  if (err instanceof ApiError) return "Error: " + err.code;
  return "Unexpected error: " + (err && err.message ? err.message : String(err));
}

function init() {
  refreshKeyUi();
  refreshConfigWarning();

  el("save-key-btn").addEventListener("click", handleSaveKey);
  el("forget-key-btn").addEventListener("click", handleForgetKey);
  el("ping-btn").addEventListener("click", handlePing);
  el("list-btn").addEventListener("click", handleList);
}

document.addEventListener("DOMContentLoaded", init);
