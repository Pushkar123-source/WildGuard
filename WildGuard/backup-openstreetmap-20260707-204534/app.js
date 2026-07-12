const state = {
  token: localStorage.getItem("wildToken") || "",
  role: localStorage.getItem("wildRole") || "",
  animals: [],
  alerts: [],
  aiEvents: [],
  aiLastEventId: Number(localStorage.getItem("wildAiLastEventId") || 0),
  logs: [],
  showFullLogs: false,
  gridNodes: [],
  mapLayer: "ALL",
  devices: { CAMERA: [], SENSOR: [], MICROPHONE: [] },
  signatures: { biological_signals: [], threat_signals: [] },
};

const $ = (selector) => document.querySelector(selector);
const roleBadge = $("#roleBadge");
const authPanel = $("#authPanel");
const dashboard = $("#dashboard");
const toast = $("#toast");
let cameraStream = null;
let cameraPrompted = false;
let remoteCameraActive = false;
let activeCameraSource = "";
let aiPollTimer = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add("hidden"), 3600);
}

function pulse(selector) {
  const element = $(selector);
  if (!element) return;
  element.classList.remove("pulse");
  void element.offsetWidth;
  element.classList.add("pulse");
}

async function api(path, options = {}) {
  const headers = options.headers || {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.detail || "Request failed");
  }
  return data;
}

function formJson(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setSession(token, role) {
  state.token = token;
  state.role = role;
  if (token) {
    localStorage.setItem("wildToken", token);
    localStorage.setItem("wildRole", role);
  } else {
    localStorage.removeItem("wildToken");
    localStorage.removeItem("wildRole");
    window.clearInterval(aiPollTimer);
    aiPollTimer = null;
  }
  renderSession();
}

function renderSession() {
  const signedIn = Boolean(state.token);
  roleBadge.textContent = signedIn ? state.role : "Signed out";
  authPanel.classList.toggle("hidden", signedIn);
  dashboard.classList.toggle("hidden", !signedIn);
  $("#logoutBtn").classList.toggle("hidden", !signedIn);
  if (signedIn) {
    refreshMap();
    refreshRoleViews();
    startAiWatch();
  }
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".tabview").forEach((view) => {
    view.classList.add("hidden");
    view.classList.remove("panel-enter");
  });
  const nextView = $(`#${name}View`);
  nextView.classList.remove("hidden");
  window.requestAnimationFrame(() => nextView.classList.add("panel-enter"));
}

function updateStats() {
  $("#statAnimals").textContent = state.animals.length;
  $("#statAlerts").textContent = state.alerts.length;
  $("#statAi").textContent = state.aiEvents.filter((event) => ["High", "Medium"].includes(event.alert_level)).length;
  $("#statDevices").textContent = Object.values(state.devices).flat().length;
  $("#statSignals").textContent = state.signatures.biological_signals.length + state.signatures.threat_signals.length;
}

function setCameraActive(active, source = "local") {
  $("#cameraFeed").classList.toggle("active", active && source === "local");
  $("#remoteVideoFeed").classList.toggle("active", active && source === "video");
  $("#remoteCameraFeed").classList.toggle("active", active && source === "remote");
  $("#remoteCameraPage").classList.toggle("active", active && source === "page");
  $("#cameraPlaceholder").classList.toggle("hidden", active);
  activeCameraSource = active ? source : "";
}

function setCameraStatus(message) {
  $("#cameraStatus").textContent = message;
  $("#cameraPlaceholder").textContent = message;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraStatus("Camera access is not available in this browser. Use Chrome, Edge, or Safari over localhost or HTTPS.");
    showToast("Camera is not available in this browser.");
    return;
  }

  try {
    stopCamera();
    cameraPrompted = true;
    setCameraStatus("Waiting for camera permission...");
    const selectedDeviceId = $("#localCameraSelect").value;
    const videoConstraint = selectedDeviceId
      ? { deviceId: { exact: selectedDeviceId } }
      : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } };
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraint,
      audio: false,
    });
    $("#cameraFeed").srcObject = cameraStream;
    remoteCameraActive = false;
    setCameraActive(true, "local");
    setCameraStatus("This device camera is running.");
    loadLocalCameras();
    showToast("Camera started.");
  } catch (error) {
    setCameraActive(false);
    const reason = error.name === "NotAllowedError"
      ? "Camera permission was blocked. Check the camera icon in Chrome address bar and allow camera."
      : error.name === "NotFoundError"
        ? "No camera was found on this device."
        : `Camera could not start: ${error.name || "unknown error"}.`;
    setCameraStatus(reason);
    showToast(reason);
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  $("#cameraFeed").srcObject = null;
  const remoteFeed = $("#remoteCameraFeed");
  remoteFeed.removeAttribute("src");
  const remoteVideo = $("#remoteVideoFeed");
  remoteVideo.pause();
  remoteVideo.removeAttribute("src");
  remoteVideo.load();
  $("#remoteCameraPage").removeAttribute("src");
  remoteCameraActive = false;
  setCameraActive(false);
  if (cameraPrompted) setCameraStatus("Camera stopped. Select a registered camera or use this device again.");
}

function captureFrame() {
  const video = $("#cameraFeed");
  const canvas = $("#cameraCanvas");
  const context = canvas.getContext("2d");

  try {
    if (cameraStream && video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    } else if (remoteCameraActive && activeCameraSource === "remote" && $("#remoteCameraFeed").complete) {
      const image = $("#remoteCameraFeed");
      canvas.width = image.naturalWidth || image.clientWidth;
      canvas.height = image.naturalHeight || image.clientHeight;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    } else if (remoteCameraActive && activeCameraSource === "video" && $("#remoteVideoFeed").videoWidth) {
      const remoteVideo = $("#remoteVideoFeed");
      canvas.width = remoteVideo.videoWidth;
      canvas.height = remoteVideo.videoHeight;
      context.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);
    } else {
      showToast("Connect a snapshot-capable camera or start this device camera first.");
      return;
    }
    $("#snapshotPreview").src = canvas.toDataURL("image/png");
  } catch (error) {
    showToast("This camera can display live video, but the browser blocked snapshots for security.");
    return;
  }

  $("#snapshotPreview").classList.add("active");
  $("#snapshotEmpty").classList.add("hidden");
  showToast("Snapshot captured.");
}

async function loadLocalCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((device) => device.kind === "videoinput");
    const selected = $("#localCameraSelect").value;
    $("#localCameraSelect").innerHTML = `<option value="">Auto rear camera</option>${videoInputs.map((device, index) => {
      const label = device.label || `Camera ${index + 1}`;
      return `<option value="${device.deviceId}">${label}</option>`;
    }).join("")}`;
    $("#localCameraSelect").value = videoInputs.some((device) => device.deviceId === selected) ? selected : "";
  } catch (error) {
    $("#localCameraSelect").innerHTML = `<option value="">Auto rear camera</option>`;
  }
}

function renderCameraPicker() {
  const cameras = state.devices.CAMERA || [];
  const select = $("#cameraSelect");
  if (!select) return;

  select.innerHTML = cameras.length
    ? cameras.map((camera) => `<option value="${camera.device_id}">${camera.name} - ${camera.location}</option>`).join("")
    : `<option value="">No registered cameras</option>`;
  renderSelectedCameraDetails();
}

function selectedCamera() {
  const selectedId = Number($("#cameraSelect").value);
  return (state.devices.CAMERA || []).find((camera) => camera.device_id === selectedId);
}

function renderSelectedCameraDetails() {
  const camera = selectedCamera();
  const details = $("#cameraDetails");
  if (!camera) {
    details.textContent = "Register a CAMERA device with a stream URL or camera web viewer URL to connect it here.";
    return;
  }
  const endpoint = camera.endpoint || "No endpoint saved";
  details.textContent = `${camera.status} | ${camera.location} | ${endpoint}`;
}

function connectRegisteredCamera() {
  const camera = selectedCamera();
  if (!camera) {
    showToast("No registered camera is selected.");
    return;
  }
  if (camera.status !== "ACTIVE") {
    showToast(`Camera is ${camera.status}. Set it ACTIVE before connecting.`);
    return;
  }
  if (!camera.endpoint) {
    showToast("This camera has no stream endpoint saved.");
    return;
  }
  stopCamera();
  const mode = resolveCameraMode(camera);
  if (camera.endpoint.toLowerCase().startsWith("rtsp://")) {
    setCameraStatus("RTSP is not directly playable in browsers. Use a camera gateway that exposes MJPEG, HLS, WebRTC, or a web viewer URL.");
    showToast("RTSP needs a browser-playable gateway.");
    return;
  }
  if (mode === "video") {
    connectVideoCamera(camera);
  } else if (mode === "page") {
    connectCameraPage(camera);
  } else {
    connectProxyImageCamera(camera);
  }
}

function normalizeBrowserEndpoint(endpoint) {
  const cleaned = endpoint.trim().split(/\s+/)[0];
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) return cleaned;
  if (cleaned.includes(":") && !cleaned.includes(".") && !cleaned.startsWith("[")) return `http://[${cleaned}]`;
  return `http://${cleaned}`;
}

function resolveCameraMode(camera) {
  const selectedMode = $("#cameraMode").value;
  if (selectedMode === "proxy-image") return "image";
  if (selectedMode === "direct-video") return "video";
  if (selectedMode === "web-page") return "page";
  const endpoint = (camera.endpoint || "").toLowerCase();
  if (endpoint.includes(".m3u8") || endpoint.includes(".mp4") || endpoint.includes(".webm") || endpoint.includes(".mov")) return "video";
  if (endpoint.includes("/view") || endpoint.includes("/viewer") || endpoint.includes("/web") || endpoint.includes("iframe")) return "page";
  return "image";
}

function connectProxyImageCamera(camera) {
  const remoteFeed = $("#remoteCameraFeed");
  const streamUrl = `/api/v1/registry/devices/${camera.device_id}/stream?token=${encodeURIComponent(state.token)}&t=${Date.now()}`;
  remoteFeed.onload = () => {
    remoteCameraActive = true;
    setCameraActive(true, "remote");
    setCameraStatus(`MJPEG/image stream connected: ${camera.name}.`);
  };
  remoteFeed.onerror = () => {
    remoteCameraActive = false;
    setCameraActive(false);
    setCameraStatus("Camera stream could not be opened as MJPEG/image. Try Direct video or Camera web page mode.");
    showToast("Try another camera stream mode.");
  };
  remoteFeed.src = streamUrl;
  remoteCameraActive = true;
  setCameraActive(true, "remote");
  setCameraStatus(`Connecting to ${camera.name}...`);
  showToast("Connecting registered camera.");
}

function connectVideoCamera(camera) {
  const remoteVideo = $("#remoteVideoFeed");
  remoteVideo.onloadedmetadata = () => {
    remoteCameraActive = true;
    setCameraActive(true, "video");
    remoteVideo.play().catch(() => {});
    setCameraStatus(`Video stream connected: ${camera.name}.`);
  };
  remoteVideo.onerror = () => {
    remoteCameraActive = false;
    setCameraActive(false);
    setCameraStatus("Video stream could not play in this browser. Try MJPEG/image proxy or Camera web page mode.");
    showToast("Video stream could not play.");
  };
  remoteVideo.src = normalizeBrowserEndpoint(camera.endpoint);
  remoteVideo.load();
  remoteCameraActive = true;
  setCameraActive(true, "video");
  setCameraStatus(`Connecting video stream: ${camera.name}...`);
  showToast("Connecting video stream.");
}

function connectCameraPage(camera) {
  const page = $("#remoteCameraPage");
  page.onload = () => {
    remoteCameraActive = true;
    setCameraActive(true, "page");
    setCameraStatus(`Camera web viewer opened: ${camera.name}.`);
  };
  page.onerror = () => {
    remoteCameraActive = false;
    setCameraActive(false);
    setCameraStatus("Camera web page could not be embedded. Open the camera URL directly in the browser.");
    showToast("Camera web page could not be embedded.");
  };
  page.src = normalizeBrowserEndpoint(camera.endpoint);
  remoteCameraActive = true;
  setCameraActive(true, "page");
  setCameraStatus(`Opening camera web viewer: ${camera.name}...`);
  showToast("Opening camera web viewer.");
}

function animalCard(animal) {
  return `
    <article class="card wildlife-card" data-species="${animal.common_name.slice(0, 2).toUpperCase()}">
      <div>
        <div class="species">${animal.common_name}</div>
        <div class="latin">${animal.scientific_name || ""}</div>
      </div>
      <div class="meta">Grid: ${animal.latitude}, ${animal.longitude}</div>
      <div class="badge-row">
        <span class="badge">${animal.category}</span>
        <span class="badge ${animal.data_integrity === "RAW_PRECISION" ? "" : "warn"}">${animal.data_integrity}</span>
      </div>
    </article>`;
}

async function refreshMap() {
  try {
    const animals = await api("/api/v1/wildlife/map");
    state.animals = animals;
    updateCategoryFilter(animals);
    renderWildlife();
    updateStats();
  } catch (error) {
    showToast(error.message);
  }
}

function updateCategoryFilter(animals) {
  const filter = $("#categoryFilter");
  const selected = filter.value || "ALL";
  const categories = [...new Set(animals.map((animal) => animal.category))].sort();
  filter.innerHTML = `<option value="ALL">All categories</option>${categories.map((category) => `<option value="${category}">${category}</option>`).join("")}`;
  filter.value = categories.includes(selected) ? selected : "ALL";
}

function filteredAnimals() {
  const query = $("#wildlifeSearch").value.trim().toLowerCase();
  const category = $("#categoryFilter").value;
  const integrity = $("#integrityFilter").value;
  return state.animals.filter((animal) => {
    const matchesQuery = !query || `${animal.common_name} ${animal.scientific_name}`.toLowerCase().includes(query);
    const matchesCategory = category === "ALL" || animal.category === category;
    const matchesIntegrity = integrity === "ALL" || animal.data_integrity === integrity;
    return matchesQuery && matchesCategory && matchesIntegrity;
  });
}

function renderWildlife() {
  const animals = filteredAnimals();
  $("#animalGrid").innerHTML = animals.length
    ? animals.map(animalCard).join("")
    : `<div class="empty-state">No wildlife records match the current filters.</div>`;
  renderMiniMap(animals);
}

function renderMiniMap(animals) {
  const map = $("#miniMap");
  if (!animals.length) {
    map.innerHTML = `<div class="map-empty">No points to show</div>`;
    return;
  }
  const latitudes = state.animals.map((animal) => animal.latitude);
  const longitudes = state.animals.map((animal) => animal.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const latSpan = maxLat - minLat || 1;
  const lngSpan = maxLng - minLng || 1;
  map.innerHTML = animals.map((animal) => {
    const left = 8 + ((animal.longitude - minLng) / lngSpan) * 84;
    const top = 8 + (1 - (animal.latitude - minLat) / latSpan) * 84;
    return `<button class="map-point" title="${animal.common_name}" style="left:${left}%;top:${top}%">${animal.common_name.slice(0, 1)}</button>`;
  }).join("");
}

function signalItem(label, sub, tone = "") {
  return `<div class="list-item"><div><strong>${label}</strong><div class="meta">${sub}</div></div>${tone}</div>`;
}

function aiEventItem(event) {
  const levelClass = event.alert_level === "High" ? "danger" : event.alert_level === "Medium" ? "warn" : "";
  const highClass = event.alert_level === "High" ? "high" : "";
  return `<div class="list-item ai-event ${highClass}">
    <div>
      <strong>${event.object_name}</strong>
      <div class="meta">${event.event_type} | ${event.device_type} ${event.device_id || ""} | ${Math.round(event.confidence * 100)}%</div>
      <div class="meta">${event.reason}</div>
    </div>
    <span class="badge ${levelClass}">${event.alert_level}</span>
  </div>`;
}

function renderAiEvents(newEvents = []) {
  const events = state.aiEvents || [];
  $("#aiEventList").innerHTML = events.length
    ? events.map(aiEventItem).join("")
    : `<div class="list-item">No AI alarms yet. Run a scan to check registered devices.</div>`;
  $("#aiStatus").textContent = events.length
    ? `GLOCK AI is watching ${events.length} event(s).`
    : "GLOCK AI is ready. No unusual activity detected yet.";

  const highEvents = newEvents.filter((event) => event.alert_level === "High");
  const banner = $("#aiAlarmBanner");
  if (highEvents.length) {
    banner.textContent = `Alarm: ${highEvents.map((event) => event.object_name).join(", ")} detected by GLOCK AI.`;
    banner.classList.remove("hidden");
    pulse("#aiAlarmBanner");
  } else if (!events.some((event) => event.alert_level === "High")) {
    banner.classList.add("hidden");
  }
  updateStats();
}

async function runAiScan(silent = false) {
  try {
    const data = await api("/api/v1/ai/glock/scan", { method: "POST" });
    state.aiEvents = data.events || [];
    const newEvents = data.new_events || [];
    const newestId = Math.max(0, ...state.aiEvents.map((event) => event.event_id || 0));
    const unseenEvents = newEvents.filter((event) => (event.event_id || 0) > state.aiLastEventId);
    renderAiEvents(unseenEvents);
    if (newestId > state.aiLastEventId) {
      state.aiLastEventId = newestId;
      localStorage.setItem("wildAiLastEventId", String(newestId));
    }
    if (!silent) showToast(`GLOCK AI scanned ${data.scanned_devices} device(s).`);
    if (unseenEvents.length) {
      showToast(`GLOCK AI alarm: ${unseenEvents.length} new event(s).`);
      refreshAlerts();
      refreshLogs();
    }
  } catch (error) {
    $("#aiEventList").innerHTML = `<div class="list-item">Available for POST_GUARD and INTERCEPTOR roles.</div>`;
    if (!silent) showToast(error.message);
  }
}

async function refreshAiEvents() {
  try {
    const data = await api("/api/v1/ai/glock/events");
    state.aiEvents = data.events || [];
    renderAiEvents();
  } catch (error) {
    $("#aiEventList").innerHTML = `<div class="list-item">Available for POST_GUARD and INTERCEPTOR roles.</div>`;
    showToast(error.message);
  }
}

function startAiWatch() {
  runAiScan(true);
  if (aiPollTimer) return;
  aiPollTimer = window.setInterval(() => runAiScan(true), 30000);
}

function objectSearchItem(result) {
  return signalItem(result.label, `${result.source} | ${result.detail} | ${Math.round(result.confidence * 100)}%`);
}

async function searchObjects(form) {
  const payload = formJson(form);
  try {
    const data = await api("/api/v1/ai/object-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("#objectSearchResults").innerHTML = data.results.length
      ? data.results.map(objectSearchItem).join("")
      : `<div class="list-item">No AI matches found for "${payload.query}".</div>`;
    showToast(`AI search found ${data.results.length} result(s).`);
  } catch (error) {
    showToast(error.message);
  }
}

function deviceItem(device) {
  const endpoint = device.endpoint ? ` | ${device.endpoint}` : "";
  const coords = device.latitude && device.longitude ? ` | ${device.latitude}, ${device.longitude}` : "";
  return `<div class="list-item device-row" data-device="${device.device_type.slice(0, 3)}">
    <div><strong>${device.name}</strong><div class="meta">${device.location}${endpoint}${coords}</div></div>
    <span class="badge ${device.status === "ACTIVE" ? "" : "warn"}">${device.status}</span>
  </div>`;
}

async function refreshSignals() {
  try {
    const data = await api("/api/v1/wildlife/signatures");
    state.signatures = data;
    $("#bioSignals").innerHTML = data.biological_signals
      .map((item) => signalItem(item.animal_name, `${item.sound_type} | ${item.frequency_range} | ${item.active_time}`))
      .join("");
    $("#threatSignals").innerHTML = data.threat_signals
      .map((item) => signalItem(item.sound_name, item.category, `<span class="badge ${item.threat_level === "High" ? "danger" : "warn"}">${item.threat_level}</span>`))
      .join("");
    updateStats();
  } catch (error) {
    $("#bioSignals").innerHTML = `<div class="list-item">Available for POST_GUARD and INTERCEPTOR roles.</div>`;
    $("#threatSignals").innerHTML = "";
    showToast(error.message);
  }
}

async function refreshAlerts() {
  try {
    const data = await api("/api/v1/interceptor/alerts");
    state.alerts = data.active_alerts;
    const alerts = data.active_alerts.length
      ? data.active_alerts.map((alert) => signalItem(`#${alert.alert_id} ${alert.detected_name}`, `${alert.detected_type} | Sensor ${alert.sensor_id} | ${Math.round(alert.confidence * 100)}%`, `<span class="badge danger">${alert.alert_level}</span>`))
      : [signalItem("No active alerts", "The tactical queue is clear.")];
    const nodes = data.grid_nodes.map((node) => signalItem(node.location, `${node.sensor_type} | ${node.status}`, `<span class="badge">${node.sensor_id}</span>`));
    $("#alertList").innerHTML = [...alerts, ...nodes].join("");
    updateStats();
  } catch (error) {
    $("#alertList").innerHTML = `<div class="list-item">Interceptor-only alert board. Guards can still raise alerts above.</div>`;
    state.alerts = [];
    updateStats();
  }
}

async function refreshLogs() {
  try {
    const logs = await api("/api/v1/security/logs");
    state.logs = logs;
    renderLogs();
  } catch (error) {
    $("#logList").innerHTML = `<div class="list-item">Available for INTERCEPTOR role.</div>`;
  }
}

function renderLogs() {
  const logs = state.logs || [];
  const visibleLogs = state.showFullLogs
    ? logs
    : logs.filter((log) => log.action === "LOGIN_SUCCESS").slice(0, 5);
  const hiddenCount = Math.max(0, logs.length - visibleLogs.length);

  $("#toggleLogs").textContent = state.showFullLogs ? "Show recent only" : "Show full audit";
  $("#logList").innerHTML = visibleLogs.length
    ? visibleLogs.map((log) => signalItem(log.action, `${log.username} | ${log.resource} | ${new Date(log.timestamp).toLocaleString()}`)).join("")
    : signalItem("No recent logins", "Full audit records are still saved.");

  if (!state.showFullLogs && hiddenCount) {
    $("#logList").insertAdjacentHTML(
      "beforeend",
      `<div class="list-item log-summary"><div><strong>${hiddenCount} audit record(s) hidden</strong><div class="meta">Use Show full audit to view saved security activity.</div></div></div>`,
    );
  }
}

async function refreshRegistry() {
  try {
    const data = await api("/api/v1/registry/devices");
    state.devices = data;
    $("#cameraRegistry").innerHTML = data.CAMERA.length
      ? data.CAMERA.map(deviceItem).join("")
      : `<div class="list-item">No cameras registered yet.</div>`;
    $("#sensorRegistry").innerHTML = data.SENSOR.length
      ? data.SENSOR.map(deviceItem).join("")
      : `<div class="list-item">No sensors registered yet.</div>`;
    $("#microphoneRegistry").innerHTML = data.MICROPHONE.length
      ? data.MICROPHONE.map(deviceItem).join("")
      : `<div class="list-item">No microphones registered yet.</div>`;
    renderCameraPicker();
    updateStats();
  } catch (error) {
    $("#cameraRegistry").innerHTML = `<div class="list-item">Available for POST_GUARD and INTERCEPTOR roles.</div>`;
    $("#sensorRegistry").innerHTML = "";
    $("#microphoneRegistry").innerHTML = "";
    renderCameraPicker();
    showToast(error.message);
    updateStats();
  }
}

function refreshRoleViews() {
  refreshSignals();
  refreshAlerts();
  refreshLogs();
  refreshRegistry();
  refreshAiEvents();
}


// Google Maps operational map upgrade
let googleMap = null;
let googleGeocoder = null;
let mapMarkers = [];
let googleMapsLoading = null;

function setMapDetails(html) {
  const details = $("#mapDetails");
  if (details) details.innerHTML = html;
}

function getGoogleMapsApiKey() {
  const input = $("#googleMapsKey");
  const typed = input?.value?.trim();
  if (typed) {
    localStorage.setItem("wildGoogleMapsKey", typed);
    return typed;
  }
  const saved = localStorage.getItem("wildGoogleMapsKey") || "";
  if (input && saved) input.value = saved;
  return saved;
}

function loadGoogleMaps() {
  if (window.google?.maps) return Promise.resolve();
  if (googleMapsLoading) return googleMapsLoading;
  const key = getGoogleMapsApiKey();
  if (!key) {
    setMapDetails("Paste your Google Maps API key, then press Load real map.");
    showToast("Google Maps API key is required.");
    return Promise.reject(new Error("Missing Google Maps API key"));
  }
  googleMapsLoading = new Promise((resolve, reject) => {
    window.initWildGoogleMap = () => resolve();
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=initWildGoogleMap`;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error("Google Maps could not load. Check API key and billing."));
    document.head.appendChild(script);
  });
  return googleMapsLoading;
}

function allDeviceRecords() {
  return Object.values(state.devices || {}).flat().filter((device) => device.latitude != null && device.longitude != null);
}

function alertRecords() {
  const nodes = state.gridNodes || [];
  return (state.alerts || []).map((alert) => {
    const node = nodes.find((item) => Number(item.sensor_id) === Number(alert.sensor_id));
    if (!node || node.latitude == null || node.longitude == null) return null;
    return {
      id: `alert-${alert.alert_id}`,
      type: "ALERT",
      label: alert.detected_name,
      subtitle: `${alert.detected_type} | ${alert.alert_level}`,
      latitude: node.latitude,
      longitude: node.longitude,
      raw: alert,
    };
  }).filter(Boolean);
}

function operationalMapRecords() {
  const wildlife = filteredAnimals().map((animal) => ({
    id: `wildlife-${animal.animal_id}`,
    type: "WILDLIFE",
    label: animal.common_name,
    subtitle: `${animal.category} | ${animal.data_integrity}`,
    latitude: animal.latitude,
    longitude: animal.longitude,
    raw: animal,
  }));
  const devices = allDeviceRecords().map((device) => ({
    id: `device-${device.device_id}`,
    type: "DEVICE",
    label: device.name,
    subtitle: `${device.device_type} | ${device.status}`,
    latitude: device.latitude,
    longitude: device.longitude,
    raw: device,
  }));
  const alerts = alertRecords();
  return [...wildlife, ...devices, ...alerts].filter((record) => {
    return state.mapLayer === "ALL" || record.type === state.mapLayer;
  });
}

function markerColor(type) {
  if (type === "ALERT") return "#ff5a4f";
  if (type === "DEVICE") return "#5df4ff";
  return "#19e39d";
}

function renderMapLegend(records) {
  const legend = $("#mapLegend");
  if (!legend) return;
  const counts = records.reduce((acc, record) => {
    acc[record.type] = (acc[record.type] || 0) + 1;
    return acc;
  }, {});
  legend.innerHTML = ["WILDLIFE", "DEVICE", "ALERT"].map((type) => {
    return `<span><i style="background:${markerColor(type)}"></i>${type}: ${counts[type] || 0}</span>`;
  }).join("");
}

function describeRecord(record) {
  return `<strong>${record.label}</strong>
    <div class="meta">${record.type} | ${record.subtitle}</div>
    <div class="meta">Latitude ${Number(record.latitude).toFixed(5)} | Longitude ${Number(record.longitude).toFixed(5)}</div>
    <div class="meta" id="geoAddress">Finding real-world address...</div>`;
}

function reverseGeocode(record) {
  if (!googleGeocoder) return;
  googleGeocoder.geocode({ location: { lat: Number(record.latitude), lng: Number(record.longitude) } }, (results, status) => {
    const address = status === "OK" && results?.[0]?.formatted_address
      ? results[0].formatted_address
      : "No address found for these coordinates.";
    const target = $("#geoAddress");
    if (target) target.textContent = address;
  });
}

async function renderGoogleMap() {
  const records = operationalMapRecords();
  renderMapLegend(records);
  if (!records.length) {
    renderMiniMapFallback(records);
    setMapDetails("No mappable records match the current filters.");
    return;
  }
  try {
    await loadGoogleMaps();
  } catch (error) {
    renderMiniMapFallback(records);
    return;
  }
  const center = {
    lat: records.reduce((sum, item) => sum + Number(item.latitude), 0) / records.length,
    lng: records.reduce((sum, item) => sum + Number(item.longitude), 0) / records.length,
  };
  if (!googleMap) {
    googleMap = new google.maps.Map($("#miniMap"), {
      center,
      zoom: 9,
      mapTypeId: "hybrid",
      streetViewControl: true,
      fullscreenControl: true,
      mapTypeControl: true,
    });
    googleGeocoder = new google.maps.Geocoder();
  }
  googleMap.setCenter(center);
  mapMarkers.forEach((marker) => marker.setMap(null));
  mapMarkers = records.map((record) => {
    const marker = new google.maps.Marker({
      position: { lat: Number(record.latitude), lng: Number(record.longitude) },
      map: googleMap,
      title: record.label,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: record.type === "ALERT" ? 10 : 8,
        fillColor: markerColor(record.type),
        fillOpacity: 0.92,
        strokeColor: "#ffffff",
        strokeWeight: 2,
      },
    });
    marker.addListener("click", () => {
      setMapDetails(describeRecord(record));
      reverseGeocode(record);
      googleMap.panTo(marker.getPosition());
    });
    return marker;
  });
  const bounds = new google.maps.LatLngBounds();
  records.forEach((record) => bounds.extend({ lat: Number(record.latitude), lng: Number(record.longitude) }));
  if (records.length > 1) googleMap.fitBounds(bounds, 64);
  setMapDetails(`${records.length} mapped record(s). Select a marker to see its real-world location.`);
}

function renderMiniMapFallback(records = operationalMapRecords()) {
  const map = $("#miniMap");
  if (!map) return;
  map.classList.add("radar-fallback");
  if (!records.length) {
    map.innerHTML = `<div class="map-empty">No points to show</div>`;
    return;
  }
  const latitudes = records.map((record) => Number(record.latitude));
  const longitudes = records.map((record) => Number(record.longitude));
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const latSpan = maxLat - minLat || 1;
  const lngSpan = maxLng - minLng || 1;
  map.innerHTML = records.map((record) => {
    const left = 8 + ((record.longitude - minLng) / lngSpan) * 84;
    const top = 8 + (1 - (record.latitude - minLat) / latSpan) * 84;
    return `<button class="map-point ${record.type.toLowerCase()}" data-map-record="${record.id}" title="${record.label}" style="left:${left}%;top:${top}%">${record.type.slice(0, 1)}</button>`;
  }).join("");
  map.querySelectorAll("[data-map-record]").forEach((point) => {
    point.addEventListener("click", () => {
      const record = records.find((item) => item.id === point.dataset.mapRecord);
      if (record) setMapDetails(describeRecord(record).replace("Finding real-world address...", "Load Google Maps for address lookup."));
    });
  });
}

const originalRefreshMap = refreshMap;
refreshMap = async function () {
  await originalRefreshMap();
  renderGoogleMap();
};

const originalRefreshRegistry = refreshRegistry;
refreshRegistry = async function () {
  await originalRefreshRegistry();
  renderGoogleMap();
};

refreshAlerts = async function () {
  try {
    const data = await api("/api/v1/interceptor/alerts");
    state.alerts = data.active_alerts;
    state.gridNodes = data.grid_nodes || [];
    const alerts = data.active_alerts.length
      ? data.active_alerts.map((alert) => signalItem(`#${alert.alert_id} ${alert.detected_name}`, `${alert.detected_type} | Sensor ${alert.sensor_id} | ${Math.round(alert.confidence * 100)}%`, `<span class="badge danger">${alert.alert_level}</span>`))
      : [signalItem("No active alerts", "The tactical queue is clear.")];
    const nodes = state.gridNodes.map((node) => signalItem(node.location, `${node.sensor_type} | ${node.status}`, `<span class="badge">${node.sensor_id}</span>`));
    $("#alertList").innerHTML = [...alerts, ...nodes].join("");
    updateStats();
    renderGoogleMap();
  } catch (error) {
    $("#alertList").innerHTML = `<div class="list-item">Interceptor-only alert board. Guards can still raise alerts above.</div>`;
    state.alerts = [];
    state.gridNodes = [];
    updateStats();
    renderGoogleMap();
  }
};
$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = new URLSearchParams(new FormData(event.currentTarget));
  try {
    const data = await api("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    setSession(data.access_token, data.role);
    showToast(`Logged in as ${data.role}`);
  } catch (error) {
    showToast(error.message);
  }
});

$("#registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formJson(event.currentTarget);
  if (payload.invite_token) {
    payload.invite_token = payload.invite_token.trim().split(/\s+/)[0];
  } else {
    delete payload.invite_token;
  }
  try {
    const user = await api("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast(`Created ${user.role} identity. You can log in now.`);
    event.currentTarget.reset();
  } catch (error) {
    showToast(error.message);
  }
});

$("#alertForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formJson(event.currentTarget);
  payload.sensor_id = Number(payload.sensor_id);
  payload.confidence = Number(payload.confidence);
  try {
    await api("/api/v1/guard/raise-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast("Alert raised.");
    pulse("#alertList");
    refreshAlerts();
    refreshLogs();
  } catch (error) {
    showToast(error.message);
  }
});

$("#cameraAlertForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formJson(event.currentTarget);
  payload.sensor_id = Number(payload.sensor_id);
  payload.confidence = Number(payload.confidence);
  try {
    await api("/api/v1/guard/raise-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast("Camera alert raised.");
    pulse("#alertList");
    refreshAlerts();
    refreshLogs();
  } catch (error) {
    showToast(error.message);
  }
});

$("#deviceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formJson(event.currentTarget);
  if (!payload.endpoint) delete payload.endpoint;
  if (payload.latitude) payload.latitude = Number(payload.latitude);
  else delete payload.latitude;
  if (payload.longitude) payload.longitude = Number(payload.longitude);
  else delete payload.longitude;
  try {
    await api("/api/v1/registry/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast("Device registered.");
    pulse("#registryView");
    refreshRegistry();
    refreshAlerts();
    refreshLogs();
  } catch (error) {
    showToast(error.message);
  }
});

$("#inviteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formJson(event.currentTarget);
  payload.expires_in_hours = Number(payload.expires_in_hours);
  try {
    const invite = await api("/api/v1/security/generate-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("#inviteOutput").textContent = `${invite.token_string} (${invite.role})`;
    showToast("Invite generated.");
  } catch (error) {
    showToast(error.message);
  }
});

$("#objectSearchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  searchObjects(event.currentTarget);
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    switchTab(tab.dataset.tab);
    if (tab.dataset.tab === "camera") {
      renderCameraPicker();
      loadLocalCameras();
      if (!cameraStream && !remoteCameraActive) setCameraStatus("Select a registered camera, then connect to its saved stream endpoint.");
    }
    if (tab.dataset.tab === "ai") {
      runAiScan(true);
    }
  });
});

document.querySelectorAll("[data-jump]").forEach((tile) => {
  tile.addEventListener("click", () => switchTab(tile.dataset.jump));
});

$("#logoutBtn").addEventListener("click", () => setSession("", ""));
$("#refreshMap").addEventListener("click", refreshMap);
$("#refreshSignals").addEventListener("click", refreshSignals);
$("#refreshAlerts").addEventListener("click", refreshAlerts);
$("#refreshLogs").addEventListener("click", refreshLogs);
$("#toggleLogs").addEventListener("click", () => {
  state.showFullLogs = !state.showFullLogs;
  renderLogs();
});
$("#refreshRegistry").addEventListener("click", refreshRegistry);
$("#runAiScan").addEventListener("click", () => runAiScan(false));
$("#refreshAiEvents").addEventListener("click", refreshAiEvents);
$("#cameraSelect").addEventListener("change", renderSelectedCameraDetails);
$("#cameraMode").addEventListener("change", renderSelectedCameraDetails);
$("#localCameraSelect").addEventListener("change", () => {
  if (cameraStream) startCamera();
});
$("#connectCamera").addEventListener("click", connectRegisteredCamera);
$("#startCamera").addEventListener("click", startCamera);
$("#stopCamera").addEventListener("click", stopCamera);
$("#captureFrame").addEventListener("click", captureFrame);
$("#wildlifeSearch").addEventListener("input", renderWildlife);
$("#categoryFilter").addEventListener("change", renderWildlife);
$("#integrityFilter").addEventListener("change", () => { renderWildlife(); renderGoogleMap(); });
$("#mapLayerFilter").addEventListener("change", (event) => {
  state.mapLayer = event.currentTarget.value;
  renderGoogleMap();
});
$("#loadRealMap").addEventListener("click", () => {
  localStorage.removeItem("wildGoogleMapsKey");
  getGoogleMapsApiKey();
  googleMapsLoading = null;
  googleMap = null;
  renderGoogleMap();
});

renderSession();
loadLocalCameras();

