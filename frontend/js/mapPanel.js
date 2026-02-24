/**
 * MapPanel — Leaflet map panel for USV position and mission visualization.
 *
 * Always-visible panel (not a viewer tile). Shows:
 *   - Basemap layer selector: online (OSM, Satellite) + offline MBTiles from server
 *       Raster MBTiles (PNG/JPG) → L.tileLayer via /tiles/{layer}/{z}/{x}/{y}.png
 *       Vector MBTiles (PBF)    → L.maplibreGL via /style/{layer}.json (MapLibre GL JS)
 *   - Overlay checkboxes: additive layers (OpenSeaMap nautical marks, etc.)
 *   - USV position arrow marker (updated in real time from NavSatFix / dummy GPS)
 *   - Active mission polyline + waypoint dots (drawn from server-provided missions.json)
 *
 * Layer data flow:
 *   Server scans maps/ dir → broadcasts ["l", {layer_name: {label}, ...}] on connect
 *   → onMapLayers() adds offline options to basemap dropdown
 *   Online layers are always available; offline layers depend on server having the file.
 *
 * Usage (in app.js):
 *   const mapPanel = new MapPanel(document.getElementById('map-panel'));
 *   conn.onMissions   = (data) => mapPanel.onMissions(data);
 *   conn.onGpsPos     = (data) => mapPanel.onGpsPos(data);
 *   conn.onMapLayers  = (data) => mapPanel.onMapLayers(data);
 */

// ----- Static layer definitions -----
// Basemaps: mutually exclusive — only one active at a time.
const ONLINE_BASEMAPS = [
    {
        name: 'osm',
        label: 'OpenStreetMap',
        online: true,
        layer: () => L.tileLayer(
            'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 19,
            }
        ),
    },
    {
        name: 'satellite',
        label: 'Satellite (ESRI)',
        online: true,
        layer: () => L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            {
                attribution: 'Tiles &copy; Esri &mdash; Source: Esri, USGS, NOAA',
                maxZoom: 19,
            }
        ),
    },
];

// Overlays: additive — any number can be active simultaneously.
const ONLINE_OVERLAYS = [
    {
        name: 'openseamap',
        label: 'OpenSeaMap (nautical)',
        layer: () => L.tileLayer(
            'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
            {
                attribution: 'Map data &copy; <a href="https://www.openseamap.org">OpenSeaMap</a> contributors',
                maxZoom: 18,
                opacity: 0.8,
            }
        ),
    },
];

class MapPanel {
    /**
     * @param {HTMLElement} panelEl — the #map-panel .panel element (already in DOM)
     */
    constructor(panelEl) {
        this._panelEl = panelEl;
        this._map = null;
        this._usvMarker = null;       // L.marker (divIcon arrow) for USV
        this._usvHeading = 0;         // last known heading in degrees
        this._missionLayer = null;    // L.polyline for mission path
        this._waypointMarkers = [];   // L.circleMarker[] for individual waypoints + arrows
        this._usvLatLng = null;       // last known USV position [lat, lng]
        this._missions = [];          // latest missions array from server

        // Layer state
        this._basemapLayers = {};     // name -> L.TileLayer (basemaps, mutually exclusive)
        this._overlayLayers = {};     // name -> L.TileLayer (overlays, additive)
        this._activeBasemap = 'osm'; // currently active basemap name
        this._activeOverlays = new Set(); // names of currently active overlays

        // UI elements
        this._basemapSelect = null;
        this._overlayContainer = null; // div holding overlay checkboxes

        // --- Smooth interpolation state ---
        this._interpFrom = null;
        this._interpTo   = null;
        this._interpHeadingFrom = 0;
        this._interpHeadingTo   = 0;
        this._interpStartMs = 0;
        this._interpDurMs   = 1100;
        this._rafId = null;

        this._initMap();
        this._initBasemaps();
        this._initOverlays();
        this._buildLayerUI();
        this._buildButtons();
        this._startInterpLoop();
    }

    // ----- Map and layer initialisation -----

    _initMap() {
        const bodyEl = this._panelEl.querySelector('.panel-body');
        bodyEl.id = 'map-container';

        this._map = L.map('map-container', {
            center: [0, 0],
            zoom: 2,
            zoomControl: true,
            attributionControl: true,
        });

        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => this._map.invalidateSize());
            ro.observe(bodyEl);
        }
    }

    _initBasemaps() {
        // Create all online basemap tile layers up front
        for (const def of ONLINE_BASEMAPS) {
            this._basemapLayers[def.name] = def.layer();
        }
        // Start with the saved basemap or OSM
        const saved = localStorage.getItem('usv_map_basemap');
        const initial = (saved && this._basemapLayers[saved]) ? saved : 'osm';
        this._activeBasemap = initial;
        this._basemapLayers[initial].addTo(this._map);
    }

    _initOverlays() {
        // Create all online overlay tile layers up front
        for (const def of ONLINE_OVERLAYS) {
            this._overlayLayers[def.name] = def.layer();
        }
        // Restore saved overlay state
        const saved = JSON.parse(localStorage.getItem('usv_map_overlays') || '[]');
        for (const name of saved) {
            if (this._overlayLayers[name]) {
                this._overlayLayers[name].addTo(this._map);
                this._activeOverlays.add(name);
            }
        }
    }

    /**
     * Called when server sends ['l', {layer_name: {label, format}, ...}].
     * Adds offline basemap options to the dropdown for each available layer.
     * Raster (PNG/JPG) layers use L.tileLayer.
     * Vector (PBF) layers use L.maplibreGL with a server-generated style JSON.
     */
    onMapLayers(data) {
        // data = { layer_name: { label, format }, ... }
        const saved = localStorage.getItem('usv_map_basemap');
        for (const [name, info] of Object.entries(data)) {
            if (this._basemapLayers[name]) continue; // already registered

            const isPbf = info.format === 'pbf';
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = info.label + (isPbf ? ' (vector)' : '');

            if (isPbf) {
                // Vector tiles rendered via MapLibre GL JS, wrapped as a Leaflet layer
                // by leaflet-maplibre-gl. Style JSON is generated server-side, pointing
                // to local /tiles, /fonts, /sprites endpoints.
                if (typeof L.maplibreGL === 'undefined') {
                    // MapLibre GL plugin not loaded — mark as unsupported
                    opt.textContent = info.label + ' ⚠ (plugin missing)';
                    opt.disabled = true;
                } else {
                    this._basemapLayers[name] = L.maplibreGL({
                        style: `${location.origin}/style/${name}.json`,
                        attribution: info.label + ' (offline vector)',
                    });
                }
            } else {
                // Raster layer — create Leaflet tile layer pointing to server proxy
                this._basemapLayers[name] = L.tileLayer(
                    `/tiles/${name}/{z}/{x}/{y}.png`,
                    {
                        attribution: info.label + ' (offline)',
                        maxZoom: 18,
                        errorTileUrl: '',  // blank tile on missing — no broken image
                    }
                );
            }

            // Append option first so select.value assignment below finds the element
            if (this._offlineGroup) this._offlineGroup.appendChild(opt);

            // Restore saved selection if this layer was previously active
            if (saved === name && this._basemapLayers[name]) {
                this._switchBasemap(name);
                if (this._basemapSelect) this._basemapSelect.value = name;
            }
        }
    }

    _buildLayerUI() {
        const header = this._panelEl.querySelector('.panel-header');

        const controls = document.createElement('div');
        controls.className = 'map-header-controls';

        // --- Basemap dropdown with optgroups ---
        this._basemapSelect = document.createElement('select');
        this._basemapSelect.className = 'iv-setting-select';
        this._basemapSelect.title = 'Basemap';

        const onlineGroup = document.createElement('optgroup');
        onlineGroup.label = 'Online';
        for (const def of ONLINE_BASEMAPS) {
            const opt = document.createElement('option');
            opt.value = def.name;
            opt.textContent = def.label;
            onlineGroup.appendChild(opt);
        }
        this._basemapSelect.appendChild(onlineGroup);

        this._offlineGroup = document.createElement('optgroup');
        this._offlineGroup.label = 'Offline';
        this._basemapSelect.appendChild(this._offlineGroup);
        // Offline options are added dynamically in onMapLayers()

        this._basemapSelect.value = this._activeBasemap;
        this._basemapSelect.addEventListener('change', () => {
            const chosen = this._basemapSelect.value;
            localStorage.setItem('usv_map_basemap', chosen);
            this._switchBasemap(chosen);
        });
        controls.appendChild(this._basemapSelect);

        // --- Overlay checkboxes ---
        this._overlayContainer = document.createElement('div');
        this._overlayContainer.className = 'map-overlay-controls';

        for (const def of ONLINE_OVERLAYS) {
            const label = document.createElement('label');
            label.className = 'map-overlay-label';
            label.title = 'Toggle ' + def.label;

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'map-overlay-cb';
            cb.checked = this._activeOverlays.has(def.name);
            cb.addEventListener('change', () => this._toggleOverlay(def.name, cb.checked));

            label.appendChild(cb);
            label.appendChild(document.createTextNode(def.label));
            this._overlayContainer.appendChild(label);
        }

        controls.appendChild(this._overlayContainer);
        header.appendChild(controls);
    }

    _switchBasemap(name) {
        const newLayer = this._basemapLayers[name];
        if (!newLayer) return;
        const oldLayer = this._basemapLayers[this._activeBasemap];
        if (oldLayer && this._map.hasLayer(oldLayer)) this._map.removeLayer(oldLayer);
        newLayer.addTo(this._map);
        // Ensure overlays stay on top after basemap swap.
        // Note: MapLibre GL layers render in a <canvas> that sits below Leaflet's
        // SVG/canvas pane, so Leaflet overlays are always on top automatically.
        for (const n of this._activeOverlays) {
            if (this._overlayLayers[n]) this._overlayLayers[n].bringToFront();
        }
        this._activeBasemap = name;
    }

    _toggleOverlay(name, active) {
        const layer = this._overlayLayers[name];
        if (!layer) return;
        if (active) {
            layer.addTo(this._map);
            layer.bringToFront();
            this._activeOverlays.add(name);
        } else {
            this._map.removeLayer(layer);
            this._activeOverlays.delete(name);
        }
        localStorage.setItem('usv_map_overlays', JSON.stringify([...this._activeOverlays]));
    }

    // ----- Action buttons -----

    _buildButtons() {
        const bodyEl = this._panelEl.querySelector('.panel-body');

        const container = document.createElement('div');
        container.className = 'map-btn-container';

        const usvBtn = document.createElement('button');
        usvBtn.className = 'map-btn';
        usvBtn.textContent = 'USV';
        usvBtn.title = 'Center map on USV position';
        usvBtn.addEventListener('click', () => this.goToUSV());

        const missionBtn = document.createElement('button');
        missionBtn.className = 'map-btn';
        missionBtn.textContent = 'Mission';
        missionBtn.title = 'Fit mission waypoints in view';
        missionBtn.addEventListener('click', () => this.fitMission());

        container.appendChild(usvBtn);
        container.appendChild(missionBtn);
        bodyEl.appendChild(container);
    }

    // ----- Public API (called by app.js) -----

    /**
     * Called when server sends ['w', {missions: [...]}].
     * Redraws the mission polyline for the first mission.
     */
    onMissions(data) {
        this._missions = data.missions || [];
        this._clearMissionLayer();
        if (this._missions.length > 0) {
            this._drawMissionPolyline(this._missions[0]);
        }
    }

    /**
     * Build the divIcon HTML for the USV heading arrow.
     * SVG triangle: tip at top-centre (north = 0°), rotated by headingDeg.
     * TODO: replace with the actual USV silhouette shape and colour.
     */
    _usvIcon(headingDeg) {
        // Pointy triangle: narrow base, tall tip — all within a 28×28 viewBox.
        // Points: tip at (14,1), base-left at (4,27), base-right at (24,27).
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
            <polygon points="14,1 4,27 14,22 24,27"
                fill="#e94560" stroke="#fff" stroke-width="1.5"
                stroke-linejoin="round"/>
        </svg>`;
        return L.divIcon({
            className: '',
            html: `<div class="map-usv-arrow" style="transform:rotate(${headingDeg}deg)">${svg}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
        });
    }

    /**
     * Called when server sends ['g', {lat, lng, heading?, topic}].
     * Records the new fix as the interpolation target — the animation loop
     * takes care of actually moving the marker smoothly.
     */
    onGpsPos(data) {
        if (data.lat === undefined || data.lng === undefined) return;
        const latlng = [data.lat, data.lng];
        this._usvLatLng = latlng;
        const heading = data.heading !== undefined ? data.heading : this._usvHeading;

        if (!this._interpTo) {
            // Very first fix — jump immediately, no interpolation needed
            this._interpFrom        = latlng;
            this._interpTo          = latlng;
            this._interpHeadingFrom = heading;
            this._interpHeadingTo   = heading;
            this._interpStartMs     = performance.now();
            this._usvHeading        = heading;

            // Create marker at first fix and auto-center
            this._usvMarker = L.marker(latlng, {
                icon: this._usvIcon(heading),
                interactive: false,
                zIndexOffset: 1000,
            }).bindTooltip('USV', { permanent: false, direction: 'top' });
            this._usvMarker.addTo(this._map);
            this._map.setView(latlng, Math.max(this._map.getZoom(), 15));
        } else {
            // Subsequent fix — start a new interpolation from current animated position
            this._interpFrom        = this._interpCurrent();
            this._interpHeadingFrom = this._usvHeading;
            this._interpTo          = latlng;
            this._interpHeadingTo   = heading;
            this._interpStartMs     = performance.now();
        }
    }

    /**
     * Return the current interpolated [lat, lng] (clamped to 0–1 progress).
     */
    _interpCurrent() {
        if (!this._interpFrom || !this._interpTo) return this._interpFrom;
        const t = Math.min(1, (performance.now() - this._interpStartMs) / this._interpDurMs);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out
        return [
            this._interpFrom[0] + (this._interpTo[0] - this._interpFrom[0]) * ease,
            this._interpFrom[1] + (this._interpTo[1] - this._interpFrom[1]) * ease,
        ];
    }

    /**
     * Interpolate heading taking the shortest angular path (handles 359°→1° wrap).
     */
    _interpHeadingCurrent() {
        if (!this._interpTo) return this._usvHeading;
        const t = Math.min(1, (performance.now() - this._interpStartMs) / this._interpDurMs);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        let delta = this._interpHeadingTo - this._interpHeadingFrom;
        // Shortest path around the circle
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        return (this._interpHeadingFrom + delta * ease + 360) % 360;
    }

    /**
     * rAF loop — runs continuously, updates marker position and heading
     * every frame so movement is silky smooth between 1 Hz GPS fixes.
     */
    _startInterpLoop() {
        const tick = () => {
            this._rafId = requestAnimationFrame(tick);
            if (!this._usvMarker || !this._interpTo) return;

            const pos     = this._interpCurrent();
            const heading = this._interpHeadingCurrent();

            this._usvMarker.setLatLng(pos);
            // Only rebuild icon when heading changed meaningfully (saves DOM work)
            if (Math.abs(heading - this._usvHeading) > 0.3) {
                this._usvHeading = heading;
                this._usvMarker.setIcon(this._usvIcon(heading));
            }
        };
        this._rafId = requestAnimationFrame(tick);
    }

    /** Center map on the USV's last known position. */
    goToUSV() {
        if (this._usvLatLng) {
            this._map.setView(this._usvLatLng, Math.max(this._map.getZoom(), 15));
        }
    }

    /** Fit all mission waypoints (and optionally USV position) into the viewport. */
    fitMission() {
        const latlngs = this._waypointMarkers.map(m => m.getLatLng());
        if (this._usvLatLng) latlngs.push(L.latLng(this._usvLatLng));
        if (latlngs.length === 0) return;
        this._map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
    }

    // ----- Mission drawing -----

    _clearMissionLayer() {
        if (this._missionLayer) {
            this._map.removeLayer(this._missionLayer);
            this._missionLayer = null;
        }
        for (const m of this._waypointMarkers) {
            this._map.removeLayer(m);
        }
        this._waypointMarkers = [];
    }

    /**
     * Compute the bearing in degrees (0 = north, clockwise) between two
     * [lat, lng] points. Used to rotate the arrow icon on each segment.
     */
    _bearing(from, to) {
        const toRad = d => d * Math.PI / 180;
        const toDeg = r => r * 180 / Math.PI;
        const dLng = toRad(to[1] - from[1]);
        const lat1 = toRad(from[0]);
        const lat2 = toRad(to[0]);
        const y = Math.sin(dLng) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) -
                  Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    /**
     * Haversine distance in metres between two [lat, lng] points.
     */
    _distanceM(a, b) {
        const R = 6371000;
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(b[0] - a[0]);
        const dLng = toRad(b[1] - a[1]);
        const sinLat = Math.sin(dLat / 2);
        const sinLng = Math.sin(dLng / 2);
        const c = sinLat * sinLat +
                  Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * sinLng * sinLng;
        return 2 * R * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
    }

    /**
     * Interpolate a point at fraction t (0–1) along segment from→to.
     */
    _interpolate(from, to, t) {
        return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    }

    _drawMissionPolyline(mission) {
        if (!mission || !mission.waypoints || mission.waypoints.length === 0) return;

        const latlngs = mission.waypoints.map(wp => [wp.lat, wp.lng]);

        const GREEN = '#4ecca3';
        const BLUE  = '#1a6fba';

        // Dashed polyline connecting waypoints
        this._missionLayer = L.polyline(latlngs, {
            color: BLUE,
            weight: 2,
            opacity: 0.85,
            dashArray: '6, 4',
        }).addTo(this._map);

        // --- Distance-based arrow placement ---
        // For each segment, place arrows at regular intervals.
        // The spacing adapts so arrows are always centred within the segment:
        //   - 1 arrow  → placed at the midpoint
        //   - N arrows → evenly spread with equal margins at each end
        const ARROW_SPACING_M = 60;   // target spacing between arrows (metres)

        for (let i = 0; i < latlngs.length - 1; i++) {
            const from   = latlngs[i];
            const to     = latlngs[i + 1];
            const segLen = this._distanceM(from, to);
            if (segLen === 0) continue;

            const angle    = this._bearing(from, to);
            const cssAngle = angle - 90;  // ▶ points east, bearing is from north

            // How many arrows fit in this segment?
            const count = Math.max(1, Math.round(segLen / ARROW_SPACING_M));
            // Space the arrows evenly, with equal gaps at both ends
            for (let j = 0; j < count; j++) {
                const t = (j + 0.5) / count;   // 0.5/N … (N-0.5)/N — never at endpoints
                const pt = this._interpolate(from, to, t);
                const arrowIcon = L.divIcon({
                    className: '',   // suppress default Leaflet white box
                    html: `<div class="map-arrow" style="transform:rotate(${cssAngle}deg)">▶</div>`,
                    iconSize: [20, 20],
                    iconAnchor: [10, 10],
                });
                const arrow = L.marker(pt, { icon: arrowIcon, interactive: false });
                arrow.addTo(this._map);
                this._waypointMarkers.push(arrow);
            }
        }

        // Individual waypoint dot markers
        for (let i = 0; i < latlngs.length; i++) {
            const marker = L.circleMarker(latlngs[i], {
                radius: 5,
                color: BLUE,       // blue border
                fillColor: GREEN,  // green fill
                fillOpacity: 1,
                weight: 2,
            }).bindTooltip(
                'WP ' + (i + 1) + ': ' +
                latlngs[i][0].toFixed(5) + ', ' + latlngs[i][1].toFixed(5),
                { direction: 'top' }
            );
            marker.addTo(this._map);
            this._waypointMarkers.push(marker);
        }
    }
}
