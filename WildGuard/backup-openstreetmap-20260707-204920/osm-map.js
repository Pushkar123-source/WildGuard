(function () {
  let userPoint = null;
  let pinnedPoint = null;
  let activeBounds = null;

  function markerColor(type) {
    if (type === "ALERT") return "#ff5a4f";
    if (type === "DEVICE") return "#5df4ff";
    if (type === "YOU") return "#f5bd42";
    if (type === "POINT") return "#ffffff";
    return "#19e39d";
  }

  function setMapDetails(html) {
    const details = document.querySelector("#mapDetails");
    if (details) details.innerHTML = html;
  }

  function getState() {
    if (typeof state !== "undefined") return state;
    return window.state || {};
  }

  function getAllDevices() {
    return Object.values(getState().devices || {})
      .flat()
      .filter((device) => device.latitude != null && device.longitude != null);
  }

  function getAlertRecords() {
    const appState = getState();
    const nodes = appState.gridNodes || [];
    return (appState.alerts || []).map((alert) => {
      const node = nodes.find((item) => Number(item.sensor_id) === Number(alert.sensor_id));
      if (!node || node.latitude == null || node.longitude == null) return null;
      return {
        id: `alert-${alert.alert_id}`,
        type: "ALERT",
        label: alert.detected_name || "Alert",
        subtitle: `${alert.detected_type || "Activity"} | ${alert.alert_level || "WATCH"}`,
        latitude: Number(node.latitude),
        longitude: Number(node.longitude),
      };
    }).filter(Boolean);
  }

  function getMapLayer() {
    return document.querySelector("#mapLayerFilter")?.value || "ALL";
  }

  function getRecords() {
    const wildlife = (typeof filteredAnimals === "function" ? filteredAnimals() : []).map((animal) => ({
      id: `wildlife-${animal.animal_id}`,
      type: "WILDLIFE",
      label: animal.common_name,
      subtitle: `${animal.category} | ${animal.data_integrity}`,
      latitude: Number(animal.latitude),
      longitude: Number(animal.longitude),
    }));
    const devices = getAllDevices().map((device) => ({
      id: `device-${device.device_id}`,
      type: "DEVICE",
      label: device.name,
      subtitle: `${device.device_type} | ${device.status}`,
      latitude: Number(device.latitude),
      longitude: Number(device.longitude),
    }));
    const extras = [];
    if (userPoint) extras.push(userPoint);
    if (pinnedPoint) extras.push(pinnedPoint);
    const records = [...wildlife, ...devices, ...getAlertRecords(), ...extras].filter((record) => {
      return Number.isFinite(record.latitude) && Number.isFinite(record.longitude);
    });
    const layer = getMapLayer();
    return layer === "ALL" ? records : records.filter((record) => record.type === layer);
  }

  function renderLegend(records) {
    const legend = document.querySelector("#mapLegend");
    if (!legend) return;
    const counts = records.reduce((acc, record) => {
      acc[record.type] = (acc[record.type] || 0) + 1;
      return acc;
    }, {});
    legend.innerHTML = ["WILDLIFE", "DEVICE", "ALERT", "YOU", "POINT"].map((type) => {
      return `<span><i style="background:${markerColor(type)}"></i>${type}: ${counts[type] || 0}</span>`;
    }).join("");
  }

  function boundsFor(records) {
    if (!records.length) {
      return { minLat: -60, maxLat: 80, minLng: -180, maxLng: 180 };
    }
    let minLat = Math.min(...records.map((record) => record.latitude));
    let maxLat = Math.max(...records.map((record) => record.latitude));
    let minLng = Math.min(...records.map((record) => record.longitude));
    let maxLng = Math.max(...records.map((record) => record.longitude));
    const latPad = Math.max((maxLat - minLat) * 0.22, 0.05);
    const lngPad = Math.max((maxLng - minLng) * 0.22, 0.05);
    return {
      minLat: Math.max(-90, minLat - latPad),
      maxLat: Math.min(90, maxLat + latPad),
      minLng: Math.max(-180, minLng - lngPad),
      maxLng: Math.min(180, maxLng + lngPad),
    };
  }

  function project(record, bounds) {
    const lngRange = Math.max(bounds.maxLng - bounds.minLng, 0.000001);
    const latRange = Math.max(bounds.maxLat - bounds.minLat, 0.000001);
    return {
      x: ((record.longitude - bounds.minLng) / lngRange) * 100,
      y: ((bounds.maxLat - record.latitude) / latRange) * 100,
    };
  }

  function labelForBounds(bounds) {
    return [
      { text: `${bounds.maxLat.toFixed(4)} lat`, left: 2, top: 4 },
      { text: `${bounds.minLat.toFixed(4)} lat`, left: 2, top: 92 },
      { text: `${bounds.minLng.toFixed(4)} lng`, left: 3, top: 82 },
      { text: `${bounds.maxLng.toFixed(4)} lng`, left: 78, top: 82 },
    ];
  }

  function describe(record) {
    const accuracy = record.accuracy ? `<div class="meta">Accuracy about ${Math.round(record.accuracy)} meter(s)</div>` : "";
    return `<strong>${record.label}</strong>
      <div class="meta">${record.type} | ${record.subtitle || "Coordinate point"}</div>
      <div class="meta">Latitude ${record.latitude.toFixed(6)} | Longitude ${record.longitude.toFixed(6)}</div>
      ${accuracy}
      <div class="meta">Offline mode: coordinates work without internet. Street names and live tiles need online map data.</div>`;
  }

  function drawMap(records) {
    const map = document.querySelector("#miniMap");
    if (!map) return;
    const terrain = document.querySelector("#terrainLayer")?.value || "terrain";
    activeBounds = boundsFor(records);
    map.innerHTML = "";
    map.className = `mini-map real-osm-map offline-map terrain-${terrain}`;

    const grid = document.createElement("div");
    grid.className = "offline-grid";
    map.appendChild(grid);

    labelForBounds(activeBounds).forEach((label) => {
      const item = document.createElement("span");
      item.className = "map-axis-label";
      item.style.left = `${label.left}%`;
      item.style.top = `${label.top}%`;
      item.textContent = label.text;
      map.appendChild(item);
    });

    records.forEach((record) => {
      const point = project(record, activeBounds);
      const pulse = document.createElement("button");
      pulse.type = "button";
      pulse.className = `offline-radar ${record.type.toLowerCase()}`;
      pulse.style.left = `${point.x}%`;
      pulse.style.top = `${point.y}%`;
      pulse.style.setProperty("--marker-color", markerColor(record.type));
      pulse.setAttribute("aria-label", `${record.label} radar area`);
      pulse.addEventListener("click", () => setMapDetails(describe(record)));
      map.appendChild(pulse);

      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = `offline-marker ${record.type.toLowerCase()}`;
      marker.style.left = `${point.x}%`;
      marker.style.top = `${point.y}%`;
      marker.style.setProperty("--marker-color", markerColor(record.type));
      marker.textContent = record.type.slice(0, 1);
      marker.title = `${record.label} (${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)})`;
      marker.addEventListener("click", () => setMapDetails(describe(record)));
      map.appendChild(marker);
    });
  }

  window.renderRealWorldMap = function renderRealWorldMap() {
    const records = getRecords();
    renderLegend(records);
    drawMap(records);
    if (!records.length) {
      setMapDetails("No latitude/longitude records match the current filters. Add a device, wildlife record, or pin coordinates.");
      return;
    }
    setMapDetails(`${records.length} offline coordinate point(s). Select a marker for latitude and longitude.`);
  };

  function locateMe() {
    if (!navigator.geolocation) {
      if (window.showToast) window.showToast("Location is not available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition((position) => {
      userPoint = {
        id: "you",
        type: "YOU",
        label: "Your current location",
        subtitle: "Browser GPS",
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      window.renderRealWorldMap();
      setMapDetails(describe(userPoint));
    }, () => {
      if (window.showToast) window.showToast("Location permission was blocked or unavailable.");
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  function pinCoordinates() {
    const lat = Number(document.querySelector("#gotoLat")?.value);
    const lng = Number(document.querySelector("#gotoLng")?.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      if (window.showToast) window.showToast("Enter valid latitude and longitude.");
      return;
    }
    pinnedPoint = {
      id: "pinned-point",
      type: "POINT",
      label: "Pinned coordinates",
      subtitle: "Manual latitude/longitude",
      latitude: lat,
      longitude: lng,
    };
    window.renderRealWorldMap();
    setMapDetails(describe(pinnedPoint));
  }

  function wrapAsync(name, after) {
    const original = window[name];
    if (typeof original !== "function") return;
    window[name] = async function (...args) {
      const result = await original.apply(this, args);
      await after();
      return result;
    };
  }

  const oldRenderWildlife = window.renderWildlife;
  if (typeof oldRenderWildlife === "function") {
    window.renderWildlife = function (...args) {
      oldRenderWildlife.apply(this, args);
      window.renderRealWorldMap();
    };
  }

  wrapAsync("refreshMap", async () => window.renderRealWorldMap());
  wrapAsync("refreshRegistry", async () => window.renderRealWorldMap());
  wrapAsync("refreshAlerts", async () => {
    if (typeof api === "function") {
      const data = await api("/api/v1/interceptor/alerts").catch(() => null);
      const appState = getState();
      if (data && appState) {
        appState.alerts = data.active_alerts || [];
        appState.gridNodes = data.grid_nodes || [];
      }
    }
    window.renderRealWorldMap();
  });

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#mapLayerFilter")?.addEventListener("change", window.renderRealWorldMap);
    document.querySelector("#terrainLayer")?.addEventListener("change", window.renderRealWorldMap);
    document.querySelector("#locateMe")?.addEventListener("click", locateMe);
    document.querySelector("#gotoCoords")?.addEventListener("click", pinCoordinates);
    document.querySelector("#wildlifeSearch")?.addEventListener("input", () => setTimeout(window.renderRealWorldMap, 0));
    document.querySelector("#categoryFilter")?.addEventListener("change", () => setTimeout(window.renderRealWorldMap, 0));
    document.querySelector("#integrityFilter")?.addEventListener("change", () => setTimeout(window.renderRealWorldMap, 0));
    setTimeout(window.renderRealWorldMap, 800);
  });
})();
