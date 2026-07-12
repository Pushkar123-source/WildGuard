(function () {
  let osmMap = null;
  let markerLayer = null;
  let radarLayer = null;
  let locationMarker = null;
  let reverseLookupTimer = null;

  function markerColor(type) {
    if (type === "ALERT") return "#ff5a4f";
    if (type === "DEVICE") return "#5df4ff";
    if (type === "YOU") return "#f5bd42";
    return "#19e39d";
  }

  function markerHtml(type) {
    return `<span class="osm-marker ${type.toLowerCase()}" style="--marker-color:${markerColor(type)}">${type.slice(0, 1)}</span>`;
  }

  function iconFor(type) {
    return L.divIcon({
      className: "osm-marker-shell",
      html: markerHtml(type),
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, -16],
    });
  }

  function setMapDetails(html) {
    const details = document.querySelector("#mapDetails");
    if (details) details.innerHTML = html;
  }

  function getAllDevices() {
    return Object.values(state.devices || {})
      .flat()
      .filter((device) => device.latitude != null && device.longitude != null);
  }

  function getAlertRecords() {
    const nodes = state.gridNodes || [];
    return (state.alerts || []).map((alert) => {
      const node = nodes.find((item) => Number(item.sensor_id) === Number(alert.sensor_id));
      if (!node || node.latitude == null || node.longitude == null) return null;
      return {
        id: `alert-${alert.alert_id}`,
        type: "ALERT",
        label: alert.detected_name,
        subtitle: `${alert.detected_type} | ${alert.alert_level}`,
        latitude: Number(node.latitude),
        longitude: Number(node.longitude),
        raw: alert,
      };
    }).filter(Boolean);
  }

  function getMapLayer() {
    return document.querySelector("#mapLayerFilter")?.value || "ALL";
  }

  function getRecords() {
    const wildlife = filteredAnimals().map((animal) => ({
      id: `wildlife-${animal.animal_id}`,
      type: "WILDLIFE",
      label: animal.common_name,
      subtitle: `${animal.category} | ${animal.data_integrity}`,
      latitude: Number(animal.latitude),
      longitude: Number(animal.longitude),
      raw: animal,
    }));
    const devices = getAllDevices().map((device) => ({
      id: `device-${device.device_id}`,
      type: "DEVICE",
      label: device.name,
      subtitle: `${device.device_type} | ${device.status}`,
      latitude: Number(device.latitude),
      longitude: Number(device.longitude),
      raw: device,
    }));
    const records = [...wildlife, ...devices, ...getAlertRecords()].filter((record) => {
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
    legend.innerHTML = ["WILDLIFE", "DEVICE", "ALERT"].map((type) => {
      return `<span><i style="background:${markerColor(type)}"></i>${type}: ${counts[type] || 0}</span>`;
    }).join("");
  }

  function describe(record) {
    return `<strong>${record.label}</strong>
      <div class="meta">${record.type} | ${record.subtitle}</div>
      <div class="meta">Latitude ${record.latitude.toFixed(6)} | Longitude ${record.longitude.toFixed(6)}</div>
      <div class="meta" id="geoAddress">Finding real-world address...</div>`;
  }

  async function reverseGeocode(record) {
    window.clearTimeout(reverseLookupTimer);
    reverseLookupTimer = window.setTimeout(async () => {
      const target = document.querySelector("#geoAddress");
      if (!target) return;
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(record.latitude)}&lon=${encodeURIComponent(record.longitude)}`;
        const response = await fetch(url, { headers: { "Accept": "application/json" } });
        const data = await response.json();
        target.textContent = data.display_name || "No address found for these coordinates.";
      } catch (error) {
        target.textContent = "Address lookup unavailable. Coordinates are shown above.";
      }
    }, 350);
  }

  function initMap(records) {
    if (!window.L) {
      setMapDetails("Map library could not load. Check your internet connection.");
      return false;
    }
    if (osmMap) return true;
    const start = records[0] ? [records[0].latitude, records[0].longitude] : [27.1751, 85.0123];
    osmMap = L.map("miniMap", {
      zoomControl: true,
      scrollWheelZoom: true,
    }).setView(start, 8);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(osmMap);
    markerLayer = L.layerGroup().addTo(osmMap);
    radarLayer = L.layerGroup().addTo(osmMap);
    return true;
  }

  function drawRadar(records) {
    radarLayer.clearLayers();
    records.forEach((record) => {
      L.circle([record.latitude, record.longitude], {
        radius: record.type === "ALERT" ? 4500 : 2500,
        color: markerColor(record.type),
        weight: 1,
        fillColor: markerColor(record.type),
        fillOpacity: record.type === "ALERT" ? 0.16 : 0.08,
      }).addTo(radarLayer);
    });
  }

  window.renderRealWorldMap = function renderRealWorldMap() {
    const records = getRecords();
    renderLegend(records);
    if (!records.length) {
      setMapDetails("No latitude/longitude records match the current filters.");
      return;
    }
    if (!initMap(records)) return;
    markerLayer.clearLayers();
    drawRadar(records);
    const bounds = L.latLngBounds(records.map((record) => [record.latitude, record.longitude]));
    records.forEach((record) => {
      const marker = L.marker([record.latitude, record.longitude], { icon: iconFor(record.type) }).addTo(markerLayer);
      marker.bindPopup(`<strong>${record.label}</strong><br>${record.subtitle}<br>${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}`);
      marker.on("click", () => {
        setMapDetails(describe(record));
        reverseGeocode(record);
      });
    });
    if (records.length > 1) osmMap.fitBounds(bounds.pad(0.15));
    else osmMap.setView([records[0].latitude, records[0].longitude], 12);
    setMapDetails(`${records.length} real-world map point(s). Select a marker for address lookup.`);
    setTimeout(() => osmMap.invalidateSize(), 80);
  };

  function locateMe() {
    if (!navigator.geolocation) {
      showToast("Location is not available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition((position) => {
      if (!osmMap) window.renderRealWorldMap();
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      if (locationMarker) locationMarker.remove();
      locationMarker = L.marker([lat, lng], { icon: iconFor("YOU") }).addTo(osmMap);
      locationMarker.bindPopup("Your current location").openPopup();
      osmMap.setView([lat, lng], 14);
      setMapDetails(`<strong>Your current location</strong><div class="meta">Latitude ${lat.toFixed(6)} | Longitude ${lng.toFixed(6)}</div>`);
    }, () => showToast("Location permission was blocked or unavailable."));
  }

  const oldRenderWildlife = window.renderWildlife || renderWildlife;
  window.renderWildlife = function () {
    oldRenderWildlife();
    window.renderRealWorldMap();
  };

  const oldRefreshMap = window.refreshMap || refreshMap;
  window.refreshMap = async function () {
    await oldRefreshMap();
    window.renderRealWorldMap();
  };

  const oldRefreshRegistry = window.refreshRegistry || refreshRegistry;
  window.refreshRegistry = async function () {
    await oldRefreshRegistry();
    window.renderRealWorldMap();
  };

  const oldRefreshAlerts = window.refreshAlerts || refreshAlerts;
  window.refreshAlerts = async function () {
    await oldRefreshAlerts();
    const data = await api("/api/v1/interceptor/alerts").catch(() => null);
    if (data) {
      state.alerts = data.active_alerts || [];
      state.gridNodes = data.grid_nodes || [];
    }
    window.renderRealWorldMap();
  };

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#mapLayerFilter")?.addEventListener("change", window.renderRealWorldMap);
    document.querySelector("#locateMe")?.addEventListener("click", locateMe);
    document.querySelector("#wildlifeSearch")?.addEventListener("input", () => setTimeout(window.renderRealWorldMap, 0));
    document.querySelector("#categoryFilter")?.addEventListener("change", () => setTimeout(window.renderRealWorldMap, 0));
    document.querySelector("#integrityFilter")?.addEventListener("change", () => setTimeout(window.renderRealWorldMap, 0));
    setTimeout(window.renderRealWorldMap, 800);
  });
})();
