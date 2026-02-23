/**
 * MapPanel — Leaflet map panel for USV position and mission visualization.
 *
 * Always-visible panel (not a viewer tile). Shows:
 *   - OpenStreetMap (online) or Offline (MBTiles) tile layer — selectable via dropdown
 *   - USV position dot (L.circleMarker, updated in real time from NavSatFix)
 *   - Active mission polyline + waypoint dots (drawn from server-provided missions.json)
 *
 * Usage (in app.js):
 *   const mapPanel = new MapPanel(document.getElementById('map-panel'));
 *   conn.onMissions = (data) => mapPanel.onMissions(data);
 *   conn.onGpsPos   = (data) => mapPanel.onGpsPos(data);
 */
class MapPanel {
    /**
     * @param {HTMLElement} panelEl — the #map-panel .panel element (already in DOM)
     */
    constructor(panelEl) {
        this._panelEl = panelEl;
        this._map = null;
        this._usvMarker = null;       // L.circleMarker for USV dot
        this._missionLayer = null;    // L.polyline for mission path
        this._waypointMarkers = [];   // L.circleMarker[] for individual waypoints
        this._usvLatLng = null;       // last known USV position [lat, lng]
        this._missions = [];          // latest missions array from server
        this._layers = {};            // layer name -> L.TileLayer
        this._activeLayerName = 'osm';
        this._mbtilesAvailable = false;
        this._layerSelect = null;
        this._mbtilesOpt = null;

        this._initMap();
        this._initLayers();
        this._buildLayerSelector();
        this._buildButtons();
        this._probeMbtiles();
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

        // Keep map sized correctly when panel resizes (e.g. window resize)
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => this._map.invalidateSize());
            ro.observe(bodyEl);
        }
    }

    _initLayers() {
        this._layers['osm'] = L.tileLayer(
            'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 19,
            }
        );

        // Offline MBTiles — served by Tornado at /tiles/{z}/{x}/{y}.png.
        // Returns 404 if no file configured; errorTileUrl='' suppresses broken img.
        this._layers['mbtiles'] = L.tileLayer(
            '/tiles/{z}/{x}/{y}.png',
            {
                attribution: 'Offline tiles',
                maxZoom: 18,
                errorTileUrl: '',
            }
        );

        // Start with OSM
        this._layers['osm'].addTo(this._map);
    }

    _buildLayerSelector() {
        const header = this._panelEl.querySelector('.panel-header');

        const controls = document.createElement('div');
        controls.className = 'map-header-controls';

        this._layerSelect = document.createElement('select');
        this._layerSelect.className = 'iv-setting-select';
        this._layerSelect.title = 'Map tile source';

        const osmOpt = document.createElement('option');
        osmOpt.value = 'osm';
        osmOpt.textContent = 'OpenStreetMap (online)';
        this._layerSelect.appendChild(osmOpt);

        this._mbtilesOpt = document.createElement('option');
        this._mbtilesOpt.value = 'mbtiles';
        this._mbtilesOpt.textContent = 'Offline (MBTiles) — not configured';
        this._mbtilesOpt.disabled = true;
        this._mbtilesOpt.title = 'Place map.mbtiles in the project root to enable';
        this._layerSelect.appendChild(this._mbtilesOpt);

        this._layerSelect.value = 'osm';
        this._layerSelect.addEventListener('change', () => {
            this._onLayerChange(this._layerSelect.value);
        });

        controls.appendChild(this._layerSelect);
        header.appendChild(controls);
    }

    _onLayerChange(layerName) {
        const newLayer = this._layers[layerName];
        if (!newLayer) return;
        const oldLayer = this._layers[this._activeLayerName];
        if (oldLayer) this._map.removeLayer(oldLayer);
        newLayer.addTo(this._map);
        this._activeLayerName = layerName;
    }

    _probeMbtiles() {
        // HEAD request to the tile server — 404 means not configured
        fetch('/tiles/0/0/0.png', { method: 'HEAD' })
            .then(resp => {
                this._mbtilesAvailable = (resp.status !== 404);
                this._updateMbtilesOption();
            })
            .catch(() => {
                this._mbtilesAvailable = false;
                this._updateMbtilesOption();
            });
    }

    _updateMbtilesOption() {
        if (!this._mbtilesOpt) return;
        if (this._mbtilesAvailable) {
            this._mbtilesOpt.disabled = false;
            this._mbtilesOpt.textContent = 'Offline (MBTiles)';
            this._mbtilesOpt.title = '';
        } else {
            this._mbtilesOpt.disabled = true;
            this._mbtilesOpt.textContent = 'Offline (MBTiles) — not configured';
            this._mbtilesOpt.title = 'Place map.mbtiles in the project root to enable';
        }
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
     * Called when server sends ['g', {lat, lng, topic}].
     * Creates or moves the USV marker.
     */
    onGpsPos(data) {
        if (data.lat === undefined || data.lng === undefined) return;
        const latlng = [data.lat, data.lng];
        this._usvLatLng = latlng;

        if (!this._usvMarker) {
            // First fix — create marker and auto-center
            this._usvMarker = L.circleMarker(latlng, {
                radius: 8,
                color: '#e94560',      // --accent
                fillColor: '#e94560',
                fillOpacity: 0.9,
                weight: 2,
            }).bindTooltip('USV', { permanent: false, direction: 'top' });
            this._usvMarker.addTo(this._map);
            this._map.setView(latlng, Math.max(this._map.getZoom(), 15));
        } else {
            this._usvMarker.setLatLng(latlng);
        }
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
