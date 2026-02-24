/**
 * USV Control - Main Application
 */

// --- Log helper ---
const logOutput = document.getElementById('log-output');
function log(msg, level = 'info') {
    const line = document.createElement('div');
    line.className = 'log-line ' + level;
    const ts = new Date().toLocaleTimeString();
    line.textContent = `[${ts}] ${msg}`;
    logOutput.appendChild(line);
    logOutput.scrollTop = logOutput.scrollHeight;
    // Keep max 200 lines
    while (logOutput.children.length > 200) {
        logOutput.removeChild(logOutput.firstChild);
    }
}

// --- Connection ---
const conn = new USVConnection();

conn.onConnect = () => {
    document.getElementById('ws-status').classList.add('connected');
    document.getElementById('ws-status-text').textContent = 'Connected';
    log('WebSocket connected to ' + window.location.host);
};

conn.onSystemInfo = (data) => {
    log('USV host: ' + data.hostname + ' (v' + data.version + ')');
    document.getElementById('ws-status-text').textContent = 'Connected — ' + data.hostname;
};

conn.onDisconnect = () => {
    document.getElementById('ws-status').classList.remove('connected');
    document.getElementById('ws-status-text').textContent = 'Disconnected';
    document.getElementById('latency-indicator').style.display = 'none';
    document.getElementById('bandwidth-indicator').style.display = 'none';
    document.getElementById('cpu-indicator').style.display = 'none';
    document.getElementById('gpu-indicator').style.display = 'none';
    latencyHistory.length = 0;
    // Clean up all viewer cards on disconnect
    for (const tn of Object.keys(activeViewers)) {
        activeViewers[tn].destroy();
        delete activeViewers[tn];
    }
    log('WebSocket disconnected', 'warn');
};

// --- Latency graph ---
const LATENCY_HISTORY_SIZE = 60;  // 60 samples = 60s at 1s ping rate
const latencyHistory = [];
const latencyCanvas = document.getElementById('latency-graph');
const latencyCtx = latencyCanvas.getContext('2d');

function getLatencyColor(ms) {
    if (ms < 50) return '#4ecca3';   // green
    if (ms < 150) return '#f0c040';  // yellow
    return '#e94560';                // red
}

function drawLatencyGraph() {
    const w = latencyCanvas.width;
    const h = latencyCanvas.height;
    const len = latencyHistory.length;
    if (len === 0) return;

    latencyCtx.clearRect(0, 0, w, h);

    // Auto-scale: max of history, clamped to at least 20ms for readability
    const maxMs = Math.max(20, ...latencyHistory) * 1.2;

    // Draw filled area + line
    const step = w / (LATENCY_HISTORY_SIZE - 1);
    const startX = w - (len - 1) * step;

    // Fill
    latencyCtx.beginPath();
    latencyCtx.moveTo(startX, h);
    for (let i = 0; i < len; i++) {
        const x = startX + i * step;
        const y = h - (latencyHistory[i] / maxMs) * (h - 2);
        latencyCtx.lineTo(x, y);
    }
    latencyCtx.lineTo(startX + (len - 1) * step, h);
    latencyCtx.closePath();
    latencyCtx.fillStyle = 'rgba(78, 204, 163, 0.15)';
    latencyCtx.fill();

    // Line
    latencyCtx.beginPath();
    for (let i = 0; i < len; i++) {
        const x = startX + i * step;
        const y = h - (latencyHistory[i] / maxMs) * (h - 2);
        if (i === 0) latencyCtx.moveTo(x, y);
        else latencyCtx.lineTo(x, y);
    }
    latencyCtx.strokeStyle = getLatencyColor(latencyHistory[len - 1]);
    latencyCtx.lineWidth = 1.5;
    latencyCtx.stroke();
}

conn.onLatency = (ms) => {
    const el = document.getElementById('latency-indicator');
    const text = document.getElementById('latency-text');
    el.style.display = '';
    text.textContent = Math.round(ms) + ' ms';
    el.classList.remove('good', 'warn', 'bad');
    if (ms < 50) el.classList.add('good');
    else if (ms < 150) el.classList.add('warn');
    else el.classList.add('bad');

    // Update history and redraw graph
    latencyHistory.push(ms);
    if (latencyHistory.length > LATENCY_HISTORY_SIZE) latencyHistory.shift();
    drawLatencyGraph();
};

// --- Bandwidth indicator ---
conn.onBandwidth = (bytesPerSec) => {
    const el = document.getElementById('bandwidth-indicator');
    const text = document.getElementById('bandwidth-text');
    el.style.display = '';
    if (bytesPerSec >= 1048576) {
        text.textContent = (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
    } else {
        text.textContent = Math.round(bytesPerSec / 1024) + ' KB/s';
    }
};

// --- System resource metrics (CPU / GPU) ---
function getResourceColor(percent) {
    if (percent < 50) return 'var(--green)';
    if (percent < 80) return 'var(--yellow)';
    return 'var(--red)';
}

conn.onResources = (data) => {
    // CPU
    if (data.cpu_percent !== undefined) {
        const cpuEl = document.getElementById('cpu-indicator');
        const cpuBar = document.getElementById('cpu-bar-fill');
        const cpuText = document.getElementById('cpu-text');
        cpuEl.style.display = '';
        const pct = Math.round(data.cpu_percent);
        cpuText.textContent = pct + '%';
        cpuBar.style.width = pct + '%';
        cpuBar.style.background = getResourceColor(pct);
    }

    // GPU
    if (data.gpu_percent !== undefined) {
        const gpuEl = document.getElementById('gpu-indicator');
        const gpuBar = document.getElementById('gpu-bar-fill');
        const gpuText = document.getElementById('gpu-text');
        gpuEl.style.display = '';
        const pct = Math.round(data.gpu_percent);
        gpuText.textContent = pct + '%';
        gpuBar.style.width = pct + '%';
        gpuBar.style.background = getResourceColor(pct);

        // Show VRAM in tooltip
        if (data.mem_used_mb !== undefined && data.mem_total_mb !== undefined) {
            gpuEl.title = 'VRAM: ' + Math.round(data.mem_used_mb) + ' / ' + Math.round(data.mem_total_mb) + ' MB';
        }
    }
};

// --- Topic viewers ---
const activeViewers = {};  // topicName (or cameraId) -> Viewer instance
const viewerArea = document.getElementById('viewer-area');
let currentTopics = {};    // latest topic map from server
let currentCameras = {};   // latest camera map from server

function subscribeTopic(topicName) {
    if (activeViewers[topicName]) return;  // already subscribed

    const topicType = currentTopics[topicName];
    if (!topicType) return;

    const ViewerClass = Viewer.getViewerForType(topicType);
    if (!ViewerClass) {
        log('No viewer for ' + topicType, 'warn');
        return;
    }

    conn.subscribe(topicName);
    activeViewers[topicName] = new ViewerClass(viewerArea, topicName, topicType, {
        onClose: (tn) => unsubscribeTopic(tn),
    });
    _wireVideoSettings(activeViewers[topicName]);
    log('Subscribed to ' + topicName);
    updateTopicListHighlights();
}

function unsubscribeTopic(topicName) {
    conn.unsubscribe(topicName);
    if (activeViewers[topicName]) {
        activeViewers[topicName].destroy();
        delete activeViewers[topicName];
    }
    log('Unsubscribed from ' + topicName);
    updateTopicListHighlights();
}

function updateTopicListHighlights() {
    const items = document.querySelectorAll('#topics-list .topic-item');
    for (const item of items) {
        const name = item.dataset.topicName;
        item.classList.toggle('subscribed', !!activeViewers[name]);
    }
}

conn.onTopics = (topics) => {
    currentTopics = topics;
    const list = document.getElementById('topics-list');
    list.innerHTML = '';
    const topicNames = Object.keys(topics).sort();
    if (topicNames.length === 0) {
        list.innerHTML = '<div class="log-line" style="color: var(--text-dim)">No topics available</div>';
        return;
    }
    for (const name of topicNames) {
        const item = document.createElement('div');
        item.className = 'topic-item';
        item.dataset.topicName = name;
        if (activeViewers[name]) item.classList.add('subscribed');
        item.innerHTML = `<span class="topic-name">${name}</span><span class="topic-type">${topics[name]}</span>`;
        item.addEventListener('click', () => {
            if (activeViewers[name]) {
                unsubscribeTopic(name);
            } else {
                subscribeTopic(name);
            }
        });
        list.appendChild(item);
    }
};

conn.onMessage = (data) => {
    const topicName = data._topic_name;
    if (topicName && activeViewers[topicName]) {
        activeViewers[topicName].update(data);
    }
};

conn.onBinaryMessage = (topicName, h264Data) => {
    if (activeViewers[topicName] && activeViewers[topicName].onVideoData) {
        activeViewers[topicName].onVideoData(h264Data);
    }
};

conn.onVideoMeta = (data) => {
    const topicName = data.topic;
    if (topicName && activeViewers[topicName] && activeViewers[topicName].onVideoMeta) {
        activeViewers[topicName].onVideoMeta(data);
    }
    log('Video stream: ' + topicName + ' ' + data.width + 'x' + data.height +
        ' @ ' + data.fps + 'fps (' + data.encoder + ')');
};

// Wire video settings callback for ImageViewer tiles
function _wireVideoSettings(viewer) {
    if (!(viewer instanceof ImageViewer)) return;
    viewer.onSettingsChange = (topic, settings) => {
        conn.sendVideoSettings(topic, settings.fps, settings.quality);
        log('Video settings: ' + topic + ' fps=' + (settings.fps || 'auto') +
            ' quality=' + settings.quality);
    };
}

// --- Direct cameras (GStreamer, bypass ROS2) ---

conn.onCameras = (cameras) => {
    currentCameras = cameras;
    const panel = document.getElementById('cameras-panel');
    const list = document.getElementById('cameras-list');
    const cameraIds = Object.keys(cameras).sort();

    if (cameraIds.length === 0) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = '';
    list.innerHTML = '';

    for (const id of cameraIds) {
        const cam = cameras[id];
        const item = document.createElement('div');
        item.className = 'topic-item camera-item';
        item.dataset.cameraId = id;
        if (activeViewers[id]) item.classList.add('subscribed');

        const detail = cam.passthrough
            ? cam.source + ' passthrough'
            : cam.source + (cam.width ? ' ' + cam.width + 'x' + cam.height + '@' + cam.fps : '');
        item.innerHTML = `<span class="topic-name">${cam.name}</span><span class="topic-type">${detail}</span>`;
        item.addEventListener('click', () => {
            if (activeViewers[id]) {
                unsubscribeCamera(id);
            } else {
                subscribeCamera(id);
            }
        });
        list.appendChild(item);
    }
};

function subscribeCamera(cameraId) {
    if (activeViewers[cameraId]) return;

    conn.subscribeCamera(cameraId);
    const cam = currentCameras[cameraId];
    const displayName = cam ? cam.name : cameraId;

    // Use ImageViewer directly — cameras always produce H.264
    activeViewers[cameraId] = new ImageViewer(viewerArea, cameraId, 'camera', {
        onClose: (id) => unsubscribeCamera(id),
    });
    _wireVideoSettings(activeViewers[cameraId]);
    log('Subscribed to camera: ' + displayName);
    updateCameraListHighlights();
}

function unsubscribeCamera(cameraId) {
    conn.unsubscribeCamera(cameraId);
    if (activeViewers[cameraId]) {
        activeViewers[cameraId].destroy();
        delete activeViewers[cameraId];
    }
    const cam = currentCameras[cameraId];
    log('Unsubscribed from camera: ' + (cam ? cam.name : cameraId));
    updateCameraListHighlights();
}

function updateCameraListHighlights() {
    const items = document.querySelectorAll('#cameras-list .topic-item');
    for (const item of items) {
        const id = item.dataset.cameraId;
        item.classList.toggle('subscribed', !!activeViewers[id]);
    }
}

// --- Map Panel ---
const mapPanel = new MapPanel(document.getElementById('map-panel'));
conn.onMissions  = (data) => mapPanel.onMissions(data);
conn.onGpsPos    = (data) => mapPanel.onGpsPos(data);
conn.onMapLayers = (data) => mapPanel.onMapLayers(data);

conn.connect();

// --- Input Manager (USB gamepad + virtual joystick) ---
const input = new InputManager(conn);

// Set up virtual joystick container
input.setVirtualContainer(document.getElementById('virtual-joy-container'));

input.onSourceSwitch = (source, deviceName) => {
    if (source === 'usb') {
        document.getElementById('joy-status').classList.add('connected');
        document.getElementById('joy-status-text').textContent = 'Joystick OK';
        document.getElementById('joy-device-name').textContent = deviceName || 'USB Gamepad';
        document.getElementById('joy-device-name').classList.add('active');
        log('Input: USB gamepad — ' + (deviceName || 'connected'));
    } else if (source === 'virtual') {
        document.getElementById('joy-status').classList.remove('connected');
        document.getElementById('joy-status-text').textContent = 'Virtual';
        document.getElementById('joy-device-name').textContent = 'Touch / Keyboard controls active';
        document.getElementById('joy-device-name').classList.remove('active');
        log('Input: Virtual joystick (touch + keyboard)');
    }
};

input.onStateChange = (axes, buttons, source, deviceName) => {
    if (source === 'usb') {
        // USB: pass remapped axes and buttons to VJ visuals (read-only mode)
        // axes[0] = throttle (raw: -1=max, +1=min), axes[1] = steering
        // Invert throttle for visual display so slider top = max throttle
        const vj = input.getVirtualJoystick();
        if (vj) {
            vj.setVisualAxes(-(axes[0] || 0), axes[1] || 0);
            vj.setVisualButtons(buttons);
        }
    }
    // Always update the data grids
    updateAxesGrid(axes);
    updateButtonsGrid(buttons);
};

function updateAxesGrid(axes) {
    const grid = document.getElementById('axes-grid');
    // Only rebuild DOM if axis count changed
    if (grid.children.length !== axes.length) {
        grid.innerHTML = '';
        const labels = ['THR', 'STR'];  // meaningful labels for first 2 axes
        for (let i = 0; i < axes.length; i++) {
            const item = document.createElement('div');
            item.className = 'axis-item';
            item.id = 'axis-' + i;
            const label = labels[i] || ('A' + i);
            item.innerHTML = `
                <span class="axis-label">${label}</span>
                <span class="axis-value" id="axis-val-${i}">0.0000</span>
                <div class="axis-bar"><div class="axis-bar-fill" id="axis-bar-${i}"></div></div>
            `;
            grid.appendChild(item);
        }
    }
    // Update values
    for (let i = 0; i < axes.length; i++) {
        const valEl = document.getElementById('axis-val-' + i);
        const barEl = document.getElementById('axis-bar-' + i);
        if (valEl) valEl.textContent = axes[i].toFixed(4);
        if (barEl) barEl.style.width = (Math.abs(axes[i]) * 100) + '%';
    }
}

function updateButtonsGrid(buttons) {
    const grid = document.getElementById('buttons-grid');
    const labels = ['F1', 'F2', 'F3', 'F4', 'REV', 'B5', 'B6', 'B7'];
    if (grid.children.length !== buttons.length) {
        grid.innerHTML = '';
        for (let i = 0; i < buttons.length; i++) {
            const item = document.createElement('div');
            item.className = 'button-item';
            item.id = 'btn-' + i;
            const label = labels[i] || ('B' + i);
            item.innerHTML = `<span class="button-label">${label}</span>`;
            grid.appendChild(item);
        }
    }
    for (let i = 0; i < buttons.length; i++) {
        const el = document.getElementById('btn-' + i);
        if (el) {
            if (buttons[i]) {
                el.classList.add('pressed');
            } else {
                el.classList.remove('pressed');
            }
        }
    }
}

// Start input manager
input.start();
log('Input manager started (USB gamepad + virtual joystick fallback)');

// --- Fullscreen overlay ---
const fullscreenOverlay = new FullscreenOverlay({
    inputManager: input,
    connection: conn,
    activeViewers: activeViewers,
});

// Hook latency and resource updates into fullscreen HUD
const _origOnLatency = conn.onLatency;
conn.onLatency = (ms) => {
    if (_origOnLatency) _origOnLatency(ms);
    fullscreenOverlay.updateLatency(ms);
};

const _origOnResources = conn.onResources;
conn.onResources = (data) => {
    if (_origOnResources) _origOnResources(data);
    fullscreenOverlay.updateResources(data);
};

// Fullscreen button
document.getElementById('fullscreen-btn').addEventListener('click', () => {
    // Find first active ImageViewer topic
    const videoTopic = Object.keys(activeViewers).find(tn => {
        const v = activeViewers[tn];
        return v && v.card && v.card.querySelector('video');
    });
    fullscreenOverlay.toggle(videoTopic || null);
});
