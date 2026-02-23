/**
 * USV WebSocket Connection Manager
 *
 * Handles connecting to the USV web server, reconnection,
 * latency measurement, and message routing.
 */

class USVConnection {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.latency = 0;
        this.reconnectInterval = 2000;
        this.hostname = '';

        // Callbacks
        this.onConnect = null;
        this.onDisconnect = null;
        this.onTopics = null;
        this.onMessage = null;
        this.onLatency = null;
        this.onBinaryMessage = null;  // (topicName, h264Data: Uint8Array)
        this.onResources = null;     // (data: {cpu_percent, gpu_percent, ...})
        this.onVideoMeta = null;     // (data: {topic, fps, width, height, encoder})
        this.onSystemInfo = null;    // (data: {hostname, version})
        this.onCameras = null;       // (cameras: {cameraId: {name, source, ...}})

        // Bandwidth tracking
        this._bytesReceived = 0;
        this._lastBwTime = 0;
        this.bandwidth = 0;  // bytes per second
        this.onBandwidth = null;
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${window.location.host}/ws`;

        console.log('[USV] Connecting to', url);
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            console.log('[USV] Connected');
            this.connected = true;
            this._bytesReceived = 0;
            this._lastBwTime = performance.now();
            this.bandwidth = 0;
            if (this.onConnect) this.onConnect();
        };

        this.ws.onclose = () => {
            console.log('[USV] Disconnected, reconnecting in', this.reconnectInterval, 'ms');
            this.connected = false;
            if (this.onDisconnect) this.onDisconnect();
            setTimeout(() => this.connect(), this.reconnectInterval);
        };

        this.ws.onerror = (err) => {
            console.error('[USV] WebSocket error:', err);
            this.ws.close();
        };

        this.ws.binaryType = 'arraybuffer';

        this.ws.onmessage = (event) => {
            // Track bandwidth
            const size = (event.data instanceof ArrayBuffer)
                ? event.data.byteLength
                : event.data.length;
            this._bytesReceived += size;
            const now = performance.now();
            if (now - this._lastBwTime >= 1000) {
                const elapsed = (now - this._lastBwTime) / 1000;
                this.bandwidth = this._bytesReceived / elapsed;
                this._bytesReceived = 0;
                this._lastBwTime = now;
                if (this.onBandwidth) this.onBandwidth(this.bandwidth);
            }

            if (event.data instanceof ArrayBuffer) {
                this._handleBinaryMessage(event.data);
            } else {
                this._handleMessage(event.data);
            }
        };
    }

    _handleBinaryMessage(buffer) {
        const view = new Uint8Array(buffer);
        if (view.length < 2) return;
        const topicNameLen = view[0];
        if (view.length < 1 + topicNameLen) return;
        const topicName = new TextDecoder().decode(view.slice(1, 1 + topicNameLen));
        const h264Data = view.slice(1 + topicNameLen);
        if (this.onBinaryMessage) {
            this.onBinaryMessage(topicName, h264Data);
        }
    }

    _handleMessage(raw) {
        let argv;
        try {
            argv = JSON.parse(raw);
        } catch (e) {
            console.error('[USV] Bad JSON:', raw);
            return;
        }

        if (!Array.isArray(argv) || argv.length < 2) return;

        const msgType = argv[0];
        const data = argv[1];

        switch (msgType) {
            case 'y': // SYSTEM
                this.hostname = data.hostname || '';
                this.version = data.version || '';
                console.log('[USV] Connected to:', this.hostname, 'v' + this.version);
                if (this.onSystemInfo) this.onSystemInfo(data);
                break;

            case 'p': // PING -> respond with PONG
                this._send(['q', { s: data.s }]);
                if (data.l !== undefined) {
                    this.latency = data.l;
                    if (this.onLatency) this.onLatency(this.latency);
                }
                break;

            case 't': // TOPICS list
                if (this.onTopics) this.onTopics(data);
                break;

            case 'm': // ROS MESSAGE
                if (this.onMessage) this.onMessage(data);
                break;

            case 'r': // SYSTEM RESOURCES (CPU/GPU)
                if (this.onResources) this.onResources(data);
                break;

            case 'v': // VIDEO STREAM METADATA (fps, resolution, encoder)
                if (this.onVideoMeta) this.onVideoMeta(data);
                break;

            case 'c': // CAMERAS list (direct GStreamer cameras)
                if (this.onCameras) this.onCameras(data);
                break;
        }
    }

    subscribe(topicName, maxUpdateRate = 24) {
        this._send(['s', { topicName: topicName, maxUpdateRate: maxUpdateRate }]);
    }

    unsubscribe(topicName) {
        this._send(['u', { topicName: topicName }]);
    }

    sendJoy(axes, buttons) {
        this._send(['j', { axes: axes, buttons: buttons }]);
    }

    subscribeCamera(cameraId) {
        this._send(['d', { cameraId: cameraId }]);
    }

    unsubscribeCamera(cameraId) {
        this._send(['e', { cameraId: cameraId }]);
    }

    /**
     * Send per-stream video settings override to the server.
     * @param {string} topic  — ROS2 topic name or camera ID
     * @param {number} fps    — target FPS (0 = auto / use source rate)
     * @param {string} quality — "low" | "medium" | "high"
     */
    sendVideoSettings(topic, fps, quality) {
        this._send(['f', { topic: topic, fps: fps || 0, quality: quality || 'medium' }]);
    }

    _send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }
}
