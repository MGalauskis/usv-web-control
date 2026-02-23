/**
 * ImageViewer — H.264 video stream viewer for sensor_msgs/Image and direct cameras.
 *
 * Receives raw H.264 NAL units via WebSocket binary frames and decodes
 * them using JMuxer (MSE + fMP4), rendering to a <video> element.
 *
 * JMuxer is created lazily on the first "v" (video meta) message so that
 * FPS is always correct from frame 1 — no timing drift, no mid-stream
 * JMuxer recreation for the common case.
 *
 * Data flow:
 *   Server FFmpeg/GStreamer → WebSocket binary → connection.onBinaryMessage
 *   → app.js routes to viewer → onVideoData() → JMuxer → <video>
 */

class ImageViewer extends Viewer {
    static get supportedTypes() { return ['sensor_msgs/msg/Image']; }
    static get maxUpdateRate() { return 30; }

    onCreate(contentEl) {
        // Video element for JMuxer output
        this.videoEl = document.createElement('video');
        this.videoEl.autoplay = true;
        this.videoEl.muted = true;
        this.videoEl.playsInline = true;
        this.videoEl.className = 'image-viewer-video';
        contentEl.appendChild(this.videoEl);

        // Status overlay
        this.statusEl = document.createElement('div');
        this.statusEl.className = 'image-viewer-status';
        this.statusEl.textContent = 'Waiting for stream info...';
        contentEl.appendChild(this.statusEl);

        // Settings toolbar
        this._buildSettingsBar(contentEl);

        // JMuxer is created lazily in onVideoMeta() once we know the real FPS.
        this.jmuxer = null;
        this._currentFps = null;      // null = not yet known
        this._pendingFrames = [];     // buffer frames that arrive before meta
        this._receivedFirstFrame = false;

        // Per-stream overrides (sent to server via "f" message)
        this._fpsOverride = 0;        // 0 = no override (use source FPS)
        this._quality = 'medium';     // low / medium / high
    }

    // ----- Settings toolbar -----

    _buildSettingsBar(contentEl) {
        const bar = document.createElement('div');
        bar.className = 'image-viewer-settings';

        // FPS override dropdown
        const fpsLabel = document.createElement('span');
        fpsLabel.className = 'iv-setting-label';
        fpsLabel.textContent = 'FPS';

        this._fpsSelect = document.createElement('select');
        this._fpsSelect.className = 'iv-setting-select';
        for (const [label, val] of [['Auto', 0], ['5', 5], ['10', 10], ['15', 15], ['20', 20], ['30', 30]]) {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = label;
            this._fpsSelect.appendChild(opt);
        }
        this._fpsSelect.value = 0;
        this._fpsSelect.addEventListener('change', () => this._onSettingsChanged());

        // Quality dropdown
        const qualLabel = document.createElement('span');
        qualLabel.className = 'iv-setting-label';
        qualLabel.textContent = 'Quality';

        this._qualSelect = document.createElement('select');
        this._qualSelect.className = 'iv-setting-select';
        for (const [label, val] of [['Low', 'low'], ['Medium', 'medium'], ['High', 'high']]) {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = label;
            this._qualSelect.appendChild(opt);
        }
        this._qualSelect.value = 'medium';
        this._qualSelect.addEventListener('change', () => this._onSettingsChanged());

        // Stream info label (resolution + encoder, filled in by onVideoMeta)
        this._infoLabel = document.createElement('span');
        this._infoLabel.className = 'iv-setting-info';

        bar.appendChild(fpsLabel);
        bar.appendChild(this._fpsSelect);
        bar.appendChild(qualLabel);
        bar.appendChild(this._qualSelect);
        bar.appendChild(this._infoLabel);
        contentEl.appendChild(bar);
    }

    _onSettingsChanged() {
        this._fpsOverride = parseInt(this._fpsSelect.value);
        this._quality = this._qualSelect.value;
        // Notify app.js so it can send the "f" message to the server
        if (this.onSettingsChange) {
            this.onSettingsChange(this.topicName, {
                fps: this._fpsOverride,
                quality: this._quality,
            });
        }
    }

    // ----- JMuxer lifecycle -----

    _createJMuxer(fps) {
        if (this.jmuxer) {
            this.jmuxer.destroy();
            this.jmuxer = null;
        }
        // JMuxer uses fps for fMP4 segment timestamp calculation.
        // flushingTime: 100ms buffer to accumulate complete NAL units before
        // building fMP4 segments — 0 causes partial-NAL decode errors.
        this.jmuxer = new JMuxer({
            node: this.videoEl,
            mode: 'video',
            flushingTime: 100,
            fps: fps,
            debug: false,
            onReady: () => {
                console.log('[ImageViewer] JMuxer ready for', this.topicName, 'at', fps, 'fps');
            },
            onError: (err) => {
                console.error('[ImageViewer] JMuxer error:', err);
                this.statusEl.textContent = 'Decoder error';
                this.statusEl.style.display = '';
            },
        });
    }

    // ----- Incoming events -----

    /**
     * Called by app.js when the server sends video stream metadata.
     * Creates JMuxer on first call (lazy init), recreates it on FPS change.
     */
    onVideoMeta(data) {
        const newFps = data.fps || 30;

        // Update info label
        if (data.width && data.height) {
            this._infoLabel.textContent =
                data.width + '×' + data.height + ' ' + (data.encoder || '');
        }

        if (newFps === this._currentFps) return;  // nothing to do

        console.log('[ImageViewer] Video meta for', this.topicName,
                    '— FPS:', this._currentFps, '->', newFps,
                    this._currentFps === null ? '(initial)' : '(changed)');

        this._currentFps = newFps;
        this._receivedFirstFrame = false;
        this.statusEl.textContent = 'Buffering...';
        this.statusEl.style.display = '';
        this._createJMuxer(newFps);

        // Flush any frames that arrived before meta was received
        if (this._pendingFrames.length > 0) {
            console.log('[ImageViewer] Flushing', this._pendingFrames.length, 'buffered frames');
            for (const frame of this._pendingFrames) {
                this.jmuxer.feed({ video: frame });
            }
            this._pendingFrames = [];
        }
    }

    /**
     * Called by app.js when binary H.264 data arrives for this topic.
     * @param {Uint8Array} h264Data — raw H.264 NAL units
     */
    onVideoData(h264Data) {
        if (this.paused) return;

        if (!this._receivedFirstFrame) {
            this._receivedFirstFrame = true;
        }

        if (!this.jmuxer) {
            // Meta not yet received — buffer up to 60 frames (~2s at 30fps)
            if (this._pendingFrames.length < 60) {
                this._pendingFrames.push(h264Data);
            }
            return;
        }

        this.jmuxer.feed({ video: h264Data });

        // Hide status overlay once video is actually playing
        if (this.statusEl.style.display !== 'none' && this.videoEl.currentTime > 0) {
            this.statusEl.style.display = 'none';
        }
    }

    /**
     * onData is not used for image topics — data arrives via the binary
     * path (onVideoData) rather than the JSON path.
     */
    onData(msg) {
        // no-op
    }

    destroy() {
        if (this.jmuxer) {
            this.jmuxer.destroy();
            this.jmuxer = null;
        }
        super.destroy();
    }
}

Viewer.registerViewer(ImageViewer);
