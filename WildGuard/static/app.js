const state = {
  token: localStorage.getItem("wildToken") || "",
  role: localStorage.getItem("wildRole") || "",
  animals: [],
  alerts: [],
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
let aiMonitorTimer = null;
let previousFrameSample = null;
let lastAiAlertAt = 0;
let leafletMap = null;
let leafletMarkers = [];

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
  $("#statDevices").textContent = Object.values(state.devices).flat().length;
  $("#statSignals").textContent = state.signatures.biological_signals.length + state.signatures.threat_signals.length;
}

function setCameraActive(active) {
  $("#cameraFeed").classList.toggle("active", active);
  $("#cameraPlaceholder").classList.toggle("hidden", active);
}

function setRemoteCameraActive(active) {
  $("#remoteCameraFrame").classList.toggle("hidden", !active);
  $("#remoteCameraFrame").classList.toggle("active", active);
  $("#cameraFeed").classList.toggle("hidden", active);
  $("#cameraPlaceholder").classList.toggle("hidden", active);
}

function clearRemoteCamera() {
  $("#remoteCameraFrame").src = "about:blank";
  setRemoteCameraActive(false);
}

function setCameraStatus(message) {
  $("#cameraStatus").textContent = message;
  $("#cameraPlaceholder").textContent = message;
}

async function loadCameraDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const select = $("#cameraDeviceSelect");
    const current = select.value;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    select.innerHTML = `<option value="">Auto camera</option>`;
    cameras.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${index + 1}`;
      select.appendChild(option);
    });
    if ([...select.options].some((option) => option.value === current)) {
      select.value = current;
    }
  } catch {
    // Device labels are often hidden until the first camera permission grant.
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraStatus("Camera access is not available in this browser. Try normal Chrome at http://127.0.0.1:8000.");
    showToast("Camera is not available in this browser.");
    return;
  }

  try {
    clearRemoteCamera();
    stopCamera();
    cameraPrompted = true;
    setCameraStatus("Waiting for camera permission...");
    const selectedDevice = $("#cameraDeviceSelect")?.value;
    const preferredVideo = selectedDevice
      ? { deviceId: { exact: selectedDevice } }
      : { facingMode: { ideal: "environment" } };
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: preferredVideo, audio: false });
    } catch (error) {
      if (selectedDevice || !["OverconstrainedError", "NotFoundError"].includes(error.name)) throw error;
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    const video = $("#cameraFeed");
    video.srcObject = cameraStream;
    await video.play().catch(() => {});
    setCameraActive(true);
    setCameraStatus("Live camera is running.");
    await loadCameraDevices();
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
  stopAiMonitor();
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  $("#cameraFeed").srcObject = null;
  setCameraActive(false);
  if (cameraPrompted) setCameraStatus("Camera stopped. Press Start camera to request it again.");
}

function renderRemoteCameraOptions() {
  const select = $("#remoteCameraSelect");
  if (!select) return;
  const current = select.value;
  const cameras = state.devices.CAMERA || [];
  const options = cameras
    .filter((device) => device.endpoint)
    .map((device) => `<option value="${device.endpoint}">${device.name} | ${device.location}</option>`)
    .join("");
  select.innerHTML = `<option value="">Select registered camera</option>${options}`;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function openRemoteCamera() {
  const selected = $("#remoteCameraSelect").value;
  const typed = $("#remoteCameraUrl").value.trim();
  const url = typed || selected;
  if (!url) {
    showToast("Add a camera URL or choose a registered camera first.");
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    showToast("Use an http:// or https:// camera URL for browser access.");
    return;
  }
  stopCamera();
  const frame = $("#remoteCameraFrame");
  frame.src = url;
  setRemoteCameraActive(true);
  setCameraStatus("Remote device camera opened.");
  showToast("Remote camera opened.");
}

function closeRemoteCamera() {
  clearRemoteCamera();
  setCameraStatus("Remote camera closed. Press Start camera to use this device camera.");
  showToast("Remote camera closed.");
}

function captureFrame() {
  const video = $("#cameraFeed");
  if (!cameraStream || !video.videoWidth) {
    showToast("Start the camera before taking a snapshot.");
    return;
  }

  const canvas = $("#cameraCanvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  $("#snapshotPreview").src = canvas.toDataURL("image/png");
  $("#snapshotPreview").classList.add("active");
  $("#snapshotEmpty").classList.add("hidden");
  showToast("Snapshot captured.");
}

function setAiBadge(text, active = false) {
  const badge = $("#aiBadge");
  badge.textContent = text;
  badge.classList.toggle("active", active);
}

function addAiFeedItem(title, detail, level = "Low") {
  const feed = $("#aiFeed");
  const item = document.createElement("div");
  item.className = "list-item ai-result";
  item.innerHTML = `<strong>${title}</strong><span>${detail}</span><span class="badge ${level === "High" ? "danger" : level === "Medium" ? "warn" : ""}">${level}</span>`;
  feed.prepend(item);
  [...feed.children].slice(5).forEach((child) => child.remove());
}

function sampleFrameMetrics() {
  const video = $("#cameraFeed");
  if (!cameraStream || !video.videoWidth) return null;

  const canvas = $("#cameraCanvas");
  const width = 96;
  const height = 54;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(video, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  let brightnessTotal = 0;
  const sample = [];

  for (let index = 0; index < pixels.length; index += 16) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    brightnessTotal += luminance;
    sample.push(luminance);
  }

  const brightness = brightnessTotal / sample.length / 255;
  let motionScore = 0;
  if (previousFrameSample?.length === sample.length) {
    let diff = 0;
    for (let index = 0; index < sample.length; index += 1) {
      diff += Math.abs(sample[index] - previousFrameSample[index]);
    }
    motionScore = diff / sample.length / 255;
  }
  previousFrameSample = sample;
  return { brightness: Number(brightness.toFixed(3)), motion_score: Number(motionScore.toFixed(3)) };
}

async function sendAiAlert(result) {
  const now = Date.now();
  if (now - lastAiAlertAt < 15000) return;
  lastAiAlertAt = now;
  const form = $("#cameraAlertForm");
  const payload = {
    sensor_id: Number(form.sensor_id.value || result.sensor_id || 101),
    detected_type: result.detected_type,
    detected_name: `AI: ${result.detected_name}`,
    confidence: Number(result.confidence),
    alert_level: result.alert_level,
  };
  await api("/api/v1/guard/raise-alert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  form.detected_type.value = result.detected_type;
  form.detected_name.value = payload.detected_name;
  form.confidence.value = payload.confidence;
  form.alert_level.value = result.alert_level;
  pulse("#alertList");
  refreshAlerts();
  refreshLogs();
}

async function analyzeFrameWithAi() {
  const metrics = sampleFrameMetrics();
  if (!metrics) {
    setAiBadge("Waiting", false);
    addAiFeedItem("Camera not ready", "Start the camera and allow permission first.", "Low");
    return;
  }

  $("#aiMotionBar").style.width = `${Math.min(100, Math.round(metrics.motion_score * 260))}%`;
  const sensorId = Number($("#cameraAlertForm").sensor_id.value || 101);
  const result = await api("/api/v1/ai/analyze-frame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...metrics, sensor_id: sensorId, source: "browser-camera" }),
  });
  const motionPercent = Math.round(result.metrics.motion_score * 100);
  const brightnessPercent = Math.round(result.metrics.brightness * 100);
  addAiFeedItem(result.detected_name, `${result.summary} Motion ${motionPercent}% | Light ${brightnessPercent}%`, result.alert_level);
  setAiBadge(result.unusual ? "Alert" : "Watching", true);
  if (result.unusual) {
    await sendAiAlert(result);
    showToast(`AI alert: ${result.detected_name}`);
  }
}

async function startAiMonitor() {
  if (!cameraStream) await startCamera();
  if (!cameraStream || aiMonitorTimer) return;
  previousFrameSample = null;
  setAiBadge("Watching", true);
  addAiFeedItem("AI monitor started", "Scanning one small frame sample every few seconds.", "Low");
  await analyzeFrameWithAi().catch((error) => showToast(error.message));
  aiMonitorTimer = window.setInterval(() => {
    analyzeFrameWithAi().catch((error) => {
      setAiBadge("Error", false);
      showToast(error.message);
    });
  }, 4500);
}

function stopAiMonitor() {
  if (aiMonitorTimer) {
    window.clearInterval(aiMonitorTimer);
    aiMonitorTimer = null;
  }
  previousFrameSample = null;
  setAiBadge("Idle", false);
}

const speciesGuide = {
  "Indian Rhinoceros": {
    nature: "A mostly solitary grassland browser that stays close to wetlands and tall riverine grass.",
    habitat: "Floodplain grasslands, marshes, and river edges.",
    track: "Large rounded three-toed track with heavy pressure at the front.",
    behavior: "Calm while grazing, but very powerful when surprised.",
    visual: "wetland",
  },
  "Bengal Tiger": {
    nature: "A stealth predator that patrols forest corridors, river edges, and dense cover.",
    habitat: "Forests, grasslands, and water-rich reserves.",
    track: "Round pugmark with four toes and a broad heel pad; claws are usually not visible.",
    behavior: "Mostly solitary and most active near dawn, dusk, and night.",
    visual: "forest",
  },
  "Asian Elephant": {
    nature: "A social herd animal that shapes forests by opening paths and spreading seeds.",
    habitat: "Forest edges, grasslands, and seasonal water routes.",
    track: "Very large circular foot impression with cracked skin marks around the edge.",
    behavior: "Moves in family groups and needs regular water access.",
    visual: "canopy",
  },
  "Wild Water Buffalo": {
    nature: "A strong wetland grazer that depends on open grass and muddy water bodies.",
    habitat: "Swamps, floodplains, grasslands, and riverine wetlands.",
    track: "Split hoof print, wide and deep, often found near mud and water.",
    behavior: "Usually in groups and defensive when threatened.",
    visual: "marsh",
  },
  "Eastern Swamp Deer": {
    nature: "A gentle deer of swampy grasslands, often seen in herds near wet meadows.",
    habitat: "Tall wet grassland, marsh, and seasonal floodplain.",
    track: "Small split hoof print with pointed tips and light pressure.",
    behavior: "Feeds in open grass and stays alert to predator movement.",
    visual: "meadow",
  },
  Leopard: {
    nature: "A highly adaptable cat that uses trees, rocks, and thick cover to stay hidden.",
    habitat: "Forests, rocky slopes, scrub, and human-edge landscapes.",
    track: "Compact round pugmark with four toes and a smaller heel pad than a tiger.",
    behavior: "Mostly nocturnal, silent, and excellent at climbing.",
    visual: "ridge",
  },
};

function guideFor(animal) {
  return speciesGuide[animal.common_name] || {
    nature: "Wildlife record under observation by the protection grid.",
    habitat: "Protected forest and field monitoring zone.",
    track: "Track details are being verified by field guards.",
    behavior: "Observe from a safe distance and record movement patterns.",
    visual: "forest",
  };
}

function animalCard(animal) {
  const guide = guideFor(animal);
  return `
    <article class="card wildlife-card species-${guide.visual}" data-species="${animal.common_name.slice(0, 2).toUpperCase()}" tabindex="0">
      <div class="species-thumb ${guide.visual}" aria-hidden="true">
        <span class="sun"></span>
        <span class="land land-a"></span>
        <span class="land land-b"></span>
        <span class="track-mini"></span>
      </div>
      <div>
        <div class="species">${animal.common_name}</div>
        <div class="latin">${animal.scientific_name || ""}</div>
      </div>
      <div class="meta">Grid: ${animal.latitude}, ${animal.longitude}</div>
      <div class="badge-row">
        <span class="badge">${animal.category}</span>
        <span class="badge ${animal.data_integrity === "RAW_PRECISION" ? "" : "warn"}">${animal.data_integrity}</span>
      </div>
      <div class="species-hover" aria-hidden="true">
        <div class="species-visuals">
          <div class="nature-photo ${guide.visual}">
            <span>Nature</span>
          </div>
          <div class="paw-photo">
            <span class="toe toe-a"></span>
            <span class="toe toe-b"></span>
            <span class="toe toe-c"></span>
            <span class="toe toe-d"></span>
            <span class="pad"></span>
            <small>Track print</small>
          </div>
        </div>
        <p>${guide.nature}</p>
        <dl>
          <div><dt>Habitat</dt><dd>${guide.habitat}</dd></div>
          <div><dt>Print</dt><dd>${guide.track}</dd></div>
          <div><dt>Nature</dt><dd>${guide.behavior}</dd></div>
        </dl>
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
  renderOperationalMap(animals);
}

function mapBounds() {
  const source = state.animals.length ? state.animals : [];
  const latitudes = source.map((animal) => animal.latitude);
  const longitudes = source.map((animal) => animal.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  return {
    minLat,
    maxLat,
    minLng,
    maxLng,
    latSpan: maxLat - minLat || 1,
    lngSpan: maxLng - minLng || 1,
    center: {
      lat: latitudes.reduce((sum, value) => sum + value, 0) / (latitudes.length || 1),
      lng: longitudes.reduce((sum, value) => sum + value, 0) / (longitudes.length || 1),
    },
  };
}

function animalMapPosition(animal, bounds) {
  return {
    left: `${8 + ((animal.longitude - bounds.minLng) / bounds.lngSpan) * 84}%`,
    top: `${8 + (1 - (animal.latitude - bounds.minLat) / bounds.latSpan) * 84}%`,
  };
}

function renderOperationalMap(animals) {
  renderLeafletMap(animals);
}

function renderLeafletMap(animals) {
  const mapElement = $("#leafletMap");
  if (!animals.length) {
    leafletMarkers.forEach((marker) => marker.remove());
    leafletMarkers = [];
    if (!leafletMap) {
      mapElement.innerHTML = `<div class="map-empty">No Leaflet points to show</div>`;
    }
    renderRadarOverlay(animals);
    return;
  }

  if (!window.L) {
    mapElement.innerHTML = `<div class="map-empty">Leaflet library could not load. Check internet connection for the Leaflet CDN.</div>`;
    renderRadarOverlay(animals);
    return;
  }

  if (!leafletMap) {
    mapElement.innerHTML = "";
    leafletMap = L.map(mapElement, {
      zoomControl: true,
      attributionControl: false,
      scrollWheelZoom: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "OpenStreetMap",
    }).addTo(leafletMap);
    leafletMap.on("move zoom resize", () => renderRadarOverlay(filteredAnimals()));
  }

  leafletMarkers.forEach((marker) => marker.remove());
  leafletMarkers = animals.map((animal) => {
    const marker = L.marker([animal.latitude, animal.longitude], {
      title: animal.common_name,
      icon: L.divIcon({
        className: "leaflet-wildlife-marker",
        html: animal.common_name.slice(0, 1),
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      }),
    }).addTo(leafletMap);
    marker.bindPopup(`<strong>${animal.common_name}</strong><br>${animal.scientific_name || ""}<br>${animal.latitude}, ${animal.longitude}`);
    return marker;
  });

  const bounds = L.latLngBounds(animals.map((animal) => [animal.latitude, animal.longitude]));
  leafletMap.fitBounds(bounds, { padding: [36, 36], maxZoom: 9 });
  window.setTimeout(() => {
    leafletMap.invalidateSize();
    renderRadarOverlay(animals);
  }, 80);
}

function renderRadarOverlay(animals) {
  const radar = $("#radarOverlay");
  if (!animals.length) {
    radar.innerHTML = `<div class="map-empty">No radar contacts</div>`;
    $("#radarStatus").textContent = "No radar contacts";
    return;
  }
  const bounds = mapBounds();
  const blips = animals.map((animal) => {
    const position = leafletMap && window.L
      ? leafletRadarPosition(animal)
      : animalMapPosition(animal, bounds);
    return `
      <button class="radar-blip" title="${animal.common_name}" style="left:${position.left};top:${position.top}">
        ${animal.common_name.slice(0, 1)}
        <span class="radar-label">${animal.common_name} | ${animal.latitude}, ${animal.longitude}</span>
      </button>`;
  }).join("");
  radar.innerHTML = `<span class="radar-sweep"></span>${blips}`;
  $("#radarStatus").textContent = `${animals.length} wildlife contacts locked`;
}

function leafletRadarPosition(animal) {
  const point = leafletMap.latLngToContainerPoint([animal.latitude, animal.longitude]);
  return {
    left: `${point.x}px`,
    top: `${point.y}px`,
  };
}

function pulseRadar() {
  const radar = $("#radarOverlay");
  radar.classList.remove("radar-pulse");
  void radar.offsetWidth;
  radar.classList.add("radar-pulse");
  const contactCount = filteredAnimals().length;
  $("#radarStatus").textContent = `Pulse sent | ${contactCount} contacts scanned`;
}

function signalItem(label, sub, tone = "") {
  return `<div class="list-item"><div><strong>${label}</strong><div class="meta">${sub}</div></div>${tone}</div>`;
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
    $("#logList").innerHTML = logs.length
      ? logs.map((log) => signalItem(log.action, `${log.username} | ${log.resource} | ${new Date(log.timestamp).toLocaleString()}`)).join("")
      : signalItem("No audit records", "Login and alert events will appear here.");
  } catch (error) {
    $("#logList").innerHTML = `<div class="list-item">Available for INTERCEPTOR role.</div>`;
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
    renderRemoteCameraOptions();
    updateStats();
  } catch (error) {
    $("#cameraRegistry").innerHTML = `<div class="list-item">Available for POST_GUARD and INTERCEPTOR roles.</div>`;
    $("#sensorRegistry").innerHTML = "";
    $("#microphoneRegistry").innerHTML = "";
    renderRemoteCameraOptions();
    showToast(error.message);
    updateStats();
  }
}

function refreshRoleViews() {
  refreshSignals();
  refreshAlerts();
  refreshLogs();
  refreshRegistry();
}

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

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    switchTab(tab.dataset.tab);
    if (tab.dataset.tab === "camera" && !cameraStream) startCamera();
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
$("#refreshRegistry").addEventListener("click", refreshRegistry);
$("#startCamera").addEventListener("click", startCamera);
$("#stopCamera").addEventListener("click", stopCamera);
$("#captureFrame").addEventListener("click", captureFrame);
$("#openRemoteCamera").addEventListener("click", openRemoteCamera);
$("#closeRemoteCamera").addEventListener("click", closeRemoteCamera);
$("#remoteCameraSelect").addEventListener("change", (event) => {
  if (event.currentTarget.value) $("#remoteCameraUrl").value = event.currentTarget.value;
});
$("#radarSweepBtn").addEventListener("click", pulseRadar);
$("#startAiMonitor").addEventListener("click", startAiMonitor);
$("#stopAiMonitor").addEventListener("click", () => {
  stopAiMonitor();
  showToast("AI monitor stopped.");
});
$("#cameraDeviceSelect").addEventListener("change", async () => {
  if (cameraStream) await startCamera();
});
$("#wildlifeSearch").addEventListener("input", renderWildlife);
$("#categoryFilter").addEventListener("change", renderWildlife);
$("#integrityFilter").addEventListener("change", renderWildlife);

loadCameraDevices();
renderSession();
