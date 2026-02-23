/**
 * Fullscreen Overlay
 *
 * Full-viewport mode with camera video background, semi-transparent
 * virtual joystick controls overlaid, and telemetry HUD.
 *
 * Usage:
 *   const fs = new FullscreenOverlay({ inputManager, connection, activeViewers });
 *   fs.enter(videoTopicName);  // or fs.toggle(videoTopicName)
 *   fs.exit();
 */

class FullscreenOverlay {
    constructor(options = {}) {
        this.inputManager = options.inputManager || null;
        this.connection = options.connection || null;
        this.activeViewers = options.activeViewers || {};  // topicName -> Viewer

        this._active = false;
        this._overlayEl = null;
        this._virtualJoy = null;
        this._videoSourceTopic = null;

        // Telemetry state
        this._latency = 0;
        this._cpuPercent = 0;
        this._gpuPercent = 0;

        // Build overlay DOM (hidden)
        this._buildOverlay();

        // Listen for browser fullscreen exit (Escape key, etc.)
        this._boundFullscreenChange = this._onFullscreenChange.bind(this);
        document.addEventListener('fullscreenchange', this._boundFullscreenChange);
        document.addEventListener('webkitfullscreenchange', this._boundFullscreenChange);
    }

    get isActive() {
        return this._active;
    }

    /**
     * Enter fullscreen with the given video topic as background.
     * If videoTopicName is null, shows "No video" placeholder.
     */
    enter(videoTopicName) {
        if (this._active) return;
        this._active = true;
        this._videoSourceTopic = videoTopicName || null;

        // Show overlay
        this._overlayEl.style.display = '';
        document.body.classList.add('fullscreen-active');

        // Attach video source
        this._attachVideo();

        // Create a virtual joystick in the fullscreen controls area
        const controlsContainer = this._overlayEl.querySelector('.fullscreen-vj-container');
        this._virtualJoy = new VirtualJoystick(controlsContainer, this.connection, {
            onInput: (axes, buttons) => {
                if (this.inputManager && this.inputManager.onStateChange) {
                    this.inputManager.onStateChange(axes, buttons, 'virtual', 'Fullscreen Virtual Joystick');
                }
            },
        });
        this._virtualJoy.enable();

        // If input manager has a virtual joystick active, disable it (we use our own)
        if (this.inputManager && this.inputManager._virtual) {
            this.inputManager._virtual.disable();
        }

        // Request browser fullscreen
        this._requestFullscreen();

        console.log('[Fullscreen] Entered');
    }

    exit() {
        if (!this._active) return;
        this._active = false;

        // Destroy fullscreen virtual joystick
        if (this._virtualJoy) {
            this._virtualJoy.destroy();
            this._virtualJoy = null;
        }

        // Detach video
        this._detachVideo();

        // Hide overlay
        this._overlayEl.style.display = 'none';
        document.body.classList.remove('fullscreen-active');

        // Re-enable the normal virtual joystick if needed
        if (this.inputManager && this.inputManager.activeSource === 'virtual' && this.inputManager._virtual) {
            this.inputManager._virtual.enable();
        }

        // Exit browser fullscreen
        this._exitFullscreen();

        console.log('[Fullscreen] Exited');
    }

    toggle(videoTopicName) {
        if (this._active) {
            this.exit();
        } else {
            this.enter(videoTopicName);
        }
    }

    /** Update telemetry values (called from app.js hooks) */
    updateLatency(ms) {
        this._latency = ms;
        if (this._active) {
            const el = this._overlayEl.querySelector('.hud-latency-val');
            if (el) el.textContent = Math.round(ms) + ' ms';
        }
    }

    updateResources(data) {
        if (data.cpu_percent !== undefined) this._cpuPercent = data.cpu_percent;
        if (data.gpu_percent !== undefined) this._gpuPercent = data.gpu_percent;
        if (this._active) {
            const cpuEl = this._overlayEl.querySelector('.hud-cpu-val');
            const gpuEl = this._overlayEl.querySelector('.hud-gpu-val');
            if (cpuEl) cpuEl.textContent = Math.round(this._cpuPercent) + '%';
            if (gpuEl) gpuEl.textContent = Math.round(this._gpuPercent) + '%';
        }
    }

    // --- DOM ---

    _buildOverlay() {
        const el = document.createElement('div');
        el.className = 'fullscreen-overlay';
        el.style.display = 'none';

        el.innerHTML = `
            <div class="fullscreen-video-container">
                <div class="fullscreen-no-video">No video stream selected</div>
            </div>
            <div class="fullscreen-hud-top">
                <div class="hud-items">
                    <div class="hud-item">
                        <span class="hud-label">LAT</span>
                        <span class="hud-latency-val">— ms</span>
                    </div>
                    <div class="hud-item">
                        <span class="hud-label">CPU</span>
                        <span class="hud-cpu-val">—%</span>
                    </div>
                    <div class="hud-item">
                        <span class="hud-label">GPU</span>
                        <span class="hud-gpu-val">—%</span>
                    </div>
                    <div class="hud-item">
                        <span class="hud-label">SPD</span>
                        <span>— kn</span>
                    </div>
                    <div class="hud-item">
                        <span class="hud-label">HDG</span>
                        <span>—°</span>
                    </div>
                </div>
                <button class="fullscreen-exit-btn" title="Exit fullscreen">✕</button>
            </div>
            <div class="fullscreen-controls">
                <div class="fullscreen-vj-container"></div>
            </div>
        `;

        // Exit button
        el.querySelector('.fullscreen-exit-btn').addEventListener('click', (e) => {
            e.preventDefault();
            this.exit();
        });
        el.querySelector('.fullscreen-exit-btn').addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.exit();
        }, { passive: false });

        this._overlayEl = el;
        document.body.appendChild(el);
    }

    _attachVideo() {
        const container = this._overlayEl.querySelector('.fullscreen-video-container');
        const noVideoEl = container.querySelector('.fullscreen-no-video');

        if (!this._videoSourceTopic || !this.activeViewers[this._videoSourceTopic]) {
            noVideoEl.style.display = '';
            return;
        }

        const viewer = this.activeViewers[this._videoSourceTopic];
        if (!viewer || !viewer.card) return;

        // Find the video element in the viewer
        const videoEl = viewer.card.querySelector('video');
        if (!videoEl) {
            noVideoEl.style.display = '';
            return;
        }

        noVideoEl.style.display = 'none';

        // Use CSS to position the original video element as fullscreen background
        // instead of reparenting (which could disrupt JMuxer)
        videoEl.classList.add('fullscreen-video-bg');
        videoEl.style.position = 'fixed';
        videoEl.style.inset = '0';
        videoEl.style.width = '100vw';
        videoEl.style.height = '100vh';
        videoEl.style.objectFit = 'contain';
        videoEl.style.zIndex = '9998';

        this._attachedVideoEl = videoEl;
    }

    _detachVideo() {
        if (this._attachedVideoEl) {
            this._attachedVideoEl.classList.remove('fullscreen-video-bg');
            this._attachedVideoEl.style.position = '';
            this._attachedVideoEl.style.inset = '';
            this._attachedVideoEl.style.width = '';
            this._attachedVideoEl.style.height = '';
            this._attachedVideoEl.style.objectFit = '';
            this._attachedVideoEl.style.zIndex = '';
            this._attachedVideoEl = null;
        }

        const noVideoEl = this._overlayEl.querySelector('.fullscreen-no-video');
        if (noVideoEl) noVideoEl.style.display = '';
    }

    // --- Browser Fullscreen API ---

    _requestFullscreen() {
        const el = document.documentElement;
        const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
        if (rfs) {
            rfs.call(el).catch(() => {
                // Fullscreen request denied (e.g., not from user gesture, or iOS Safari)
                // Overlay still works as a viewport-filling div
                console.log('[Fullscreen] Browser fullscreen API not available, using viewport overlay');
            });
        }
    }

    _exitFullscreen() {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            const efs = document.exitFullscreen || document.webkitExitFullscreen;
            if (efs) efs.call(document);
        }
    }

    _onFullscreenChange() {
        // If user pressed Escape to exit browser fullscreen, also close our overlay
        if (this._active && !document.fullscreenElement && !document.webkitFullscreenElement) {
            this.exit();
        }
    }
}
