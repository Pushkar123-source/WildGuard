(function () {
  const mapView = {
    centerLat: 27.1751,
    centerLng: 85.0123,
    zoom: 5,
    fitted: false,
    dragging: false,
    dragStart: null,
    dragCenter: null,
    aiHighlights: new Set(),
    aiRoute: [],
    riskZones: [],
  };

  let userPoint = null;
  let pinnedPoint = null;

  function markerColor(type) {
    if (type === "ALERT") return "#ff5a4f";
    if (type === "DEVICE") return "#5df4ff";
    if (type === "YOU") return "#f5bd42";
    if (type === "POINT") return "#ffffff";
    return "#19e39d";
  }

  function getState() {
    if (typeof state !== "undefined") return state;
    return window.state || {};
  }

  function setMapDetails(html) {
    const details = document.querySelector("#mapDetails");
    if (details) details.innerHTML = html;
  }

  function showToastSafe(message) {
    if (typeof showToast === "function") showToast(message);
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
        priority: alert.alert_level || "WATCH",
        source: alert,
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
      source: animal,
    }));
    const devices = getAllDevices().map((device) => ({
      id: `device-${device.device_id}`,
      type: "DEVICE",
      label: device.name,
      subtitle: `${device.device_type} | ${device.status}`,
      latitude: Number(device.latitude),
      longitude: Number(device.longitude),
      source: device,
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

  function spans() {
    const scale = Math.pow(2, mapView.zoom);
    return {
      lat: 120 / scale,
      lng: 220 / scale,
    };
  }

  function boundsFromView() {
    const span = spans();
    return {
      minLat: Math.max(-90, mapView.centerLat - span.lat / 2),
      maxLat: Math.min(90, mapView.centerLat + span.lat / 2),
      minLng: Math.max(-180, mapView.centerLng - span.lng / 2),
      maxLng: Math.min(180, mapView.centerLng + span.lng / 2),
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

  function unproject(clientX, clientY) {
    const map = document.querySelector("#miniMap");
    const rect = map.getBoundingClientRect();
    const bounds = boundsFromView();
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return {
      latitude: bounds.maxLat - y * (bounds.maxLat - bounds.minLat),
      longitude: bounds.minLng + x * (bounds.maxLng - bounds.minLng),
    };
  }

  function clampView() {
    mapView.centerLat = Math.max(-89.9, Math.min(89.9, mapView.centerLat));
    mapView.centerLng = Math.max(-179.9, Math.min(179.9, mapView.centerLng));
    mapView.zoom = Math.max(1, Math.min(12, mapView.zoom));
  }

  function distanceKm(a, b) {
    const toRad = (value) => value * Math.PI / 180;
    const earth = 6371;
    const dLat = toRad(b.latitude - a.latitude);
    const dLng = toRad(b.longitude - a.longitude);
    const lat1 = toRad(a.latitude);
    const lat2 = toRad(b.latitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * earth * Math.asin(Math.sqrt(h));
  }

  function fitToRecords(records) {
    const usable = records.filter((record) => record.type !== "POINT" || record.id === "pinned-point");
    if (!usable.length) return;
    const minLat = Math.min(...usable.map((record) => record.latitude));
    const maxLat = Math.max(...usable.map((record) => record.latitude));
    const minLng = Math.min(...usable.map((record) => record.longitude));
    const maxLng = Math.max(...usable.map((record) => record.longitude));
    mapView.centerLat = (minLat + maxLat) / 2;
    mapView.centerLng = (minLng + maxLng) / 2;
    const needLat = Math.max(maxLat - minLat, 0.05) * 1.35;
    const needLng = Math.max(maxLng - minLng, 0.05) * 1.35;
    const zoomLat = Math.log2(120 / needLat);
    const zoomLng = Math.log2(220 / needLng);
    mapView.zoom = Math.max(1, Math.min(12, Math.floor(Math.min(zoomLat, zoomLng))));
    mapView.fitted = true;
    clampView();
  }

  function describe(record) {
    const accuracy = record.accuracy ? `<div class="meta">Accuracy about ${Math.round(record.accuracy)} meter(s)</div>` : "";
    const nearest = nearestRecords(record, getRecords().filter((item) => item.id !== record.id), 3);
    const nearby = nearest.length
      ? `<div class="meta">Nearest: ${nearest.map((item) => `${item.record.label} ${item.km.toFixed(1)} km`).join(", ")}</div>`
      : "";
    return `<strong>${record.label}</strong>
      <div class="meta">${record.type} | ${record.subtitle || "Coordinate point"}</div>
      <div class="meta">Latitude ${record.latitude.toFixed(6)} | Longitude ${record.longitude.toFixed(6)}</div>
      ${accuracy}
      ${nearby}
      <div class="meta">Drag to move, wheel to zoom, double-click map to pin a new point.</div>`;
  }

  function nearestRecords(origin, records, count) {
    return records
      .filter((record) => Number.isFinite(record.latitude) && Number.isFinite(record.longitude))
      .map((record) => ({ record, km: distanceKm(origin, record) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, count);
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

  function axisLabels(bounds) {
    return [
      { text: `${bounds.maxLat.toFixed(4)} lat`, left: 2, top: 4 },
      { text: `${bounds.minLat.toFixed(4)} lat`, left: 2, top: 92 },
      { text: `${bounds.minLng.toFixed(4)} lng`, left: 3, top: 82 },
      { text: `${bounds.maxLng.toFixed(4)} lng`, left: 78, top: 82 },
      { text: `Zoom ${mapView.zoom.toFixed(1)}x`, left: 44, top: 4 },
    ];
  }

  function drawRoute(map, records, bounds) {
    if (!mapView.aiRoute.length) return;
    const points = mapView.aiRoute
      .map((id) => records.find((record) => record.id === id))
      .filter(Boolean)
      .map((record) => project(record, bounds));
    if (points.length < 2) return;
    const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ai-route-layer");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", polyline);
    line.setAttribute("class", "ai-route-line");
    svg.appendChild(line);
    map.appendChild(svg);
  }

  function drawMap(records) {
    const map = document.querySelector("#miniMap");
    if (!map) return;
    if (!mapView.fitted && records.length) fitToRecords(records);
    const terrain = document.querySelector("#terrainLayer")?.value || "terrain";
    const bounds = boundsFromView();
    map.innerHTML = `
      <div class="map-zoom-controls">
        <button id="zoomInMap" type="button" aria-label="Zoom in">+</button>
        <button id="zoomOutMap" type="button" aria-label="Zoom out">-</button>
      </div>
      <div id="mapCoordinateReadout" class="map-coordinate-readout">Move pointer on map</div>
      <div class="offline-grid"></div>
    `;
    map.className = `mini-map real-osm-map offline-map terrain-${terrain}`;

    axisLabels(bounds).forEach((label) => {
      const item = document.createElement("span");
      item.className = "map-axis-label";
      item.style.left = `${label.left}%`;
      item.style.top = `${label.top}%`;
      item.textContent = label.text;
      map.appendChild(item);
    });

    mapView.riskZones.forEach((zone) => {
      const point = project(zone, bounds);
      if (point.x < -20 || point.x > 120 || point.y < -20 || point.y > 120) return;
      const risk = document.createElement("button");
      risk.type = "button";
      risk.className = `ai-risk-zone ${zone.level}`;
      risk.style.left = `${point.x}%`;
      risk.style.top = `${point.y}%`;
      risk.textContent = `${zone.score}`;
      risk.addEventListener("click", () => setMapDetails(zone.detail));
      map.appendChild(risk);
    });

    drawRoute(map, records, bounds);

    records.forEach((record) => {
      const point = project(record, bounds);
      if (point.x < -8 || point.x > 108 || point.y < -8 || point.y > 108) return;
      const isHighlighted = mapView.aiHighlights.has(record.id);
      const pulse = document.createElement("button");
      pulse.type = "button";
      pulse.className = `offline-radar ${record.type.toLowerCase()}${isHighlighted ? " ai-highlight" : ""}`;
      pulse.style.left = `${point.x}%`;
      pulse.style.top = `${point.y}%`;
      pulse.style.setProperty("--marker-color", markerColor(record.type));
      pulse.setAttribute("aria-label", `${record.label} radar area`);
      pulse.addEventListener("click", () => setMapDetails(describe(record)));
      map.appendChild(pulse);

      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = `offline-marker ${record.type.toLowerCase()}${isHighlighted ? " ai-highlight" : ""}`;
      marker.style.left = `${point.x}%`;
      marker.style.top = `${point.y}%`;
      marker.style.setProperty("--marker-color", markerColor(record.type));
      marker.textContent = record.type.slice(0, 1);
      marker.title = `${record.label} (${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)})`;
      marker.addEventListener("click", (event) => {
        event.stopPropagation();
        setMapDetails(describe(record));
      });
      map.appendChild(marker);
    });

    bindMapInteractions();
  }

  function updateCoordinateReadout(event) {
    const readout = document.querySelector("#mapCoordinateReadout");
    if (!readout) return;
    const coord = unproject(event.clientX, event.clientY);
    readout.textContent = `Lat ${coord.latitude.toFixed(6)} | Lng ${coord.longitude.toFixed(6)}`;
  }

  function bindMapInteractions() {
    const map = document.querySelector("#miniMap");
    if (!map || map.dataset.bound === "1") return;
    map.dataset.bound = "1";

    map.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      map.setPointerCapture(event.pointerId);
      mapView.dragging = true;
      mapView.dragStart = { x: event.clientX, y: event.clientY };
      mapView.dragCenter = { lat: mapView.centerLat, lng: mapView.centerLng };
      map.classList.add("is-dragging");
    });

    map.addEventListener("pointermove", (event) => {
      updateCoordinateReadout(event);
      if (!mapView.dragging || !mapView.dragStart || !mapView.dragCenter) return;
      const rect = map.getBoundingClientRect();
      const span = spans();
      const dx = event.clientX - mapView.dragStart.x;
      const dy = event.clientY - mapView.dragStart.y;
      mapView.centerLng = mapView.dragCenter.lng - (dx / rect.width) * span.lng;
      mapView.centerLat = mapView.dragCenter.lat + (dy / rect.height) * span.lat;
      clampView();
      window.requestAnimationFrame(() => drawMap(getRecords()));
    });

    map.addEventListener("pointerup", (event) => {
      mapView.dragging = false;
      map.classList.remove("is-dragging");
      try { map.releasePointerCapture(event.pointerId); } catch (error) {}
    });

    map.addEventListener("wheel", (event) => {
      event.preventDefault();
      mapView.zoom += event.deltaY < 0 ? 0.5 : -0.5;
      clampView();
      drawMap(getRecords());
    }, { passive: false });

    map.addEventListener("dblclick", (event) => {
      if (event.target.closest("button")) return;
      event.preventDefault();
      const coord = unproject(event.clientX, event.clientY);
      pinCoordinate(coord.latitude, coord.longitude);
    });

    map.addEventListener("click", (event) => {
      if (event.target.id === "zoomInMap") {
        event.stopPropagation();
        zoomMap(1);
      }
      if (event.target.id === "zoomOutMap") {
        event.stopPropagation();
        zoomMap(-1);
      }
    });
  }

  function zoomMap(direction) {
    mapView.zoom += direction;
    clampView();
    drawMap(getRecords());
  }

  window.renderRealWorldMap = function renderRealWorldMap() {
    const records = getRecords();
    renderLegend(records);
    drawMap(records);
    if (!records.length) {
      setMapDetails("No latitude/longitude records match the current filters. Add a device, wildlife record, or pin coordinates.");
      return;
    }
    const bounds = boundsFromView();
    setMapDetails(`${records.length} map point(s). View: ${bounds.minLat.toFixed(4)} to ${bounds.maxLat.toFixed(4)} latitude, ${bounds.minLng.toFixed(4)} to ${bounds.maxLng.toFixed(4)} longitude.`);
  };

  function locateMe() {
    if (!navigator.geolocation) {
      showToastSafe("Location is not available in this browser.");
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
      mapView.centerLat = userPoint.latitude;
      mapView.centerLng = userPoint.longitude;
      mapView.zoom = Math.max(mapView.zoom, 8);
      mapView.fitted = true;
      window.renderRealWorldMap();
      setMapDetails(describe(userPoint));
    }, () => {
      showToastSafe("Location permission was blocked or unavailable.");
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  function pinCoordinate(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      showToastSafe("Enter valid latitude and longitude.");
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
    document.querySelector("#gotoLat").value = lat.toFixed(6);
    document.querySelector("#gotoLng").value = lng.toFixed(6);
    mapView.centerLat = lat;
    mapView.centerLng = lng;
    mapView.fitted = true;
    window.renderRealWorldMap();
    setMapDetails(describe(pinnedPoint));
  }

  function pinCoordinatesFromInput() {
    pinCoordinate(Number(document.querySelector("#gotoLat")?.value), Number(document.querySelector("#gotoLng")?.value));
  }

  function aiFind() {
    const query = (document.querySelector("#aiMapQuery")?.value || "").trim().toLowerCase();
    if (!query) {
      showToastSafe("Type an object, species, sensor, device, or alert to find.");
      return;
    }
    const records = getRecords();
    const matches = records.filter((record) => {
      return `${record.label} ${record.subtitle} ${record.type}`.toLowerCase().includes(query);
    });
    mapView.aiHighlights = new Set(matches.map((record) => record.id));
    if (matches[0]) {
      mapView.centerLat = matches[0].latitude;
      mapView.centerLng = matches[0].longitude;
      mapView.zoom = Math.max(mapView.zoom, 7);
      mapView.fitted = true;
    }
    window.renderRealWorldMap();
    setMapDetails(matches.length
      ? `<strong>AI search found ${matches.length} match(es)</strong><div class="meta">${matches.map((record) => record.label).join(", ")}</div>`
      : `<strong>No AI map matches found</strong><div class="meta">Try a species, device name, sensor type, or alert word.</div>`);
  }

  function aiRiskScan() {
    const records = getRecords();
    const alerts = records.filter((record) => record.type === "ALERT");
    const devices = records.filter((record) => record.type === "DEVICE");
    const wildlife = records.filter((record) => record.type === "WILDLIFE");
    mapView.riskZones = alerts.map((alert) => {
      const nearbyWildlife = wildlife.filter((record) => distanceKm(alert, record) < 8).length;
      const nearbyDevices = devices.filter((record) => distanceKm(alert, record) < 10).length;
      const score = Math.min(99, 45 + nearbyWildlife * 12 + Math.max(0, 3 - nearbyDevices) * 10);
      const level = score >= 75 ? "high" : score >= 55 ? "medium" : "low";
      return {
        id: `risk-${alert.id}`,
        latitude: alert.latitude,
        longitude: alert.longitude,
        score,
        level,
        detail: `<strong>AI risk scan: ${level.toUpperCase()} ${score}/99</strong><div class="meta">${nearbyWildlife} wildlife record(s) nearby, ${nearbyDevices} device(s) within response range.</div><div class="meta">Recommended action: verify camera feed, check nearest sensor, and dispatch patrol if score is high.</div>`,
      };
    });
    window.renderRealWorldMap();
    setMapDetails(mapView.riskZones.length
      ? `<strong>AI risk scan complete</strong><div class="meta">${mapView.riskZones.length} risk zone(s) marked on the map.</div>`
      : `<strong>No active alert risk zones</strong><div class="meta">The AI scan needs alert points or sensor events to score risk.</div>`);
  }

  function aiPatrolRoute() {
    const records = getRecords();
    const start = userPoint || pinnedPoint || records.find((record) => record.type === "DEVICE") || records[0];
    if (!start) {
      showToastSafe("No map points available for patrol routing.");
      return;
    }
    const targets = records
      .filter((record) => record.id !== start.id && ["ALERT", "WILDLIFE", "DEVICE"].includes(record.type))
      .map((record) => ({ record, score: (record.type === "ALERT" ? -100 : 0) + distanceKm(start, record) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 5)
      .map((item) => item.record);
    mapView.aiRoute = [start, ...targets].map((record) => record.id);
    mapView.aiHighlights = new Set(mapView.aiRoute);
    window.renderRealWorldMap();
    setMapDetails(targets.length
      ? `<strong>AI patrol route generated</strong><div class="meta">Route: ${[start, ...targets].map((record) => record.label).join(" -> ")}</div>`
      : `<strong>No route targets found</strong><div class="meta">Add alerts, wildlife points, or registered devices.</div>`);
  }

  function clearAi() {
    mapView.aiHighlights.clear();
    mapView.aiRoute = [];
    mapView.riskZones = [];
    window.renderRealWorldMap();
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
    document.querySelector("#mapLayerFilter")?.addEventListener("change", () => { mapView.fitted = false; window.renderRealWorldMap(); });
    document.querySelector("#terrainLayer")?.addEventListener("change", window.renderRealWorldMap);
    document.querySelector("#locateMe")?.addEventListener("click", locateMe);
    document.querySelector("#gotoCoords")?.addEventListener("click", pinCoordinatesFromInput);
    document.querySelector("#fitMap")?.addEventListener("click", () => { mapView.fitted = false; fitToRecords(getRecords()); window.renderRealWorldMap(); });
    document.querySelector("#aiFind")?.addEventListener("click", aiFind);
    document.querySelector("#aiRisk")?.addEventListener("click", aiRiskScan);
    document.querySelector("#aiPatrol")?.addEventListener("click", aiPatrolRoute);
    document.querySelector("#aiClear")?.addEventListener("click", clearAi);
    document.querySelector("#aiMapQuery")?.addEventListener("keydown", (event) => { if (event.key === "Enter") aiFind(); });
    document.querySelector("#wildlifeSearch")?.addEventListener("input", () => setTimeout(() => { mapView.fitted = false; window.renderRealWorldMap(); }, 0));
    document.querySelector("#categoryFilter")?.addEventListener("change", () => setTimeout(() => { mapView.fitted = false; window.renderRealWorldMap(); }, 0));
    document.querySelector("#integrityFilter")?.addEventListener("change", () => setTimeout(() => { mapView.fitted = false; window.renderRealWorldMap(); }, 0));
    setTimeout(window.renderRealWorldMap, 800);
  });
})();
