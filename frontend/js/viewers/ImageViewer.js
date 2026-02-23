/**
 * ImageViewer — H.264 video stream viewer for sensor_msgs/Image topics.
 *
 * Receives raw H.264 NAL units via WebSocket binary frames and decodes
 * them using JMuxer (MSE + fMP4), rendering to a <video> element.
 *
 * Data flow:
 *   Server FFmpeg → WebSocket binary → connection.onBinaryMessage
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
        this.statusEl.textContent = 'Waiting for video stream...';
        contentEl.appendChild(this.statusEl);

        this._currentFps = 30;  // default until server tells us
        this._createJMuxer(this._currentFps);

        this._receivedFirstFrame = false;
    }

    _createJMuxer(fps) {
        // Destroy existing instance if any
        if (this.jmuxer) {
            this.jmuxer.destroy();
            this.jmuxer = null;
        }

        // JMuxer uses fps for fMP4 segment timestamp calculation.
        // Must match the actual encoding rate or playback timing drifts.
        // flushingTime: small buffer (100ms) to accumulate complete NAL units
        //   before building fMP4 segments. 0 causes partial-NAL decode errors.
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
            }
        });
    }

    /**
     * Called by app.js when the server sends video stream metadata.
     * Reconfigures JMuxer if the FPS changed.
     */
    onVideoMeta(data) {
        const newFps = data.fps || 30;
        if (newFps !== this._currentFps) {
            console.log('[ImageViewer] FPS changed for', this.topicName,
                        ':', this._currentFps, '->', newFps, '- recreating JMuxer');
            this._currentFps = newFps;
            this._receivedFirstFrame = false;
            this.statusEl.textContent = 'Reconfiguring...';
            this.statusEl.style.display = '';
            this._createJMuxer(newFps);
        }
    }

    /**
     * Called by app.js when binary H.264 data arrives for this topic.
     * @param {Uint8Array} h264Data — raw H.264 NAL units from FFmpeg
     */
    onVideoData(h264Data) {
        if (this.paused) return;

        if (!this._receivedFirstFrame) {
            this._receivedFirstFrame = true;
            this.statusEl.textContent = 'Buffering...';
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
