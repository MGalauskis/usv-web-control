/**
 * Virtual Joystick Module
 *
 * Touch + keyboard-driven throttle/steering controls for devices
 * without a USB gamepad. Sends the same ["j", {...}] WebSocket
 * message format as JoystickCapture.
 *
 * Controls:
 *  - Left: Throttle slider (vertical, no spring-return)
 *  - Right: Steering slider (horizontal, spring-return to center)
 *  - Buttons: F1–F4 (momentary), REV (toggle), Emergency Stop
 *
 * Keyboard bindings (always active when virtual joystick is enabled):
 *  W/↑ = throttle up, S/↓ = throttle down
 *  A/← = steer left, D/→ = steer right
 *  Space = instant throttle zero
 *  R = toggle reverse
 *  1–4 = function buttons
 *
 * Tap = ±0.1 step, Hold = continuous ramp at ~1.0/s
 */

class VirtualJoystick {
    constructor(containerEl, connection, options = {}) {
        this.container = containerEl;
        this.connection = connection;
        this.deadzone = options.deadzone || 0.05;
        this.pollRate = options.pollRate || 50; // Hz

        // Internal state
        this._throttle = -1;   // [-1, 1], starts at bottom (no power), no spring-return
        this._steering = 0;    // [-1, 1], spring-return on release
        this._buttons = new Array(8).fill(0);  // 0–3: func, 4: reverse toggle, 5–7: reserved
        this._reverseActive = false;

        // Steering decay (gradual return to center on keyboard release)
        this._steeringDecaying = false;
        this._STEERING_DECAY_RATE = 0.1; // units per second (~10s from full deflection)

        // Touch tracking (per-slider touch identifier)
        this._throttleTouchId = null;
        this._steeringTouchId = null;

        // Keyboard state
        this._keysDown = new Set();
        this._keyHoldTimers = {};  // key -> { startTime, stepped }
        this._KEY_STEP = 0.1;
        this._RAMP_RATE = 1.0;    // units per second
        this._HOLD_DELAY = 200;   // ms before ramp starts

        // Polling
        this._pollTimer = null;
        this._lastAxes = [];
        this._lastButtons = [];
        this._active = false;
        this._readonly = false;

        // Safety watchdog
        this._lastPollTime = 0;
        this._watchdogTimer = null;
        this._watchdogTripped = false;

        // Callbacks
        this.onInput = options.onInput || null;

        // DOM references (set in _buildDOM)
        this._dom = {};

        // Bound handlers (for removal)
        this._boundKeyDown = this._onKeyDown.bind(this);
        this._boundKeyUp = this._onKeyUp.bind(this);

        this._buildDOM();
    }

    // --- Public API ---

    get axes() {
        return [this._roundAxis(this._throttle), this._roundAxis(this._steering)];
    }

    get buttons() {
        return this._buttons.slice();
    }

    enable() {
        if (this._active) return;
        this._active = true;
        this._readonly = false;
        this._dom.root.classList.remove('vj-readonly');
        this.container.classList.remove('vj-readonly-container');

        // Keyboard listeners
        document.addEventListener('keydown', this._boundKeyDown);
        document.addEventListener('keyup', this._boundKeyUp);

        // Start polling
        this._pollTimer = setInterval(() => this._poll(), 1000 / this.pollRate);

        // Start safety watchdog (2Hz)
        this._lastPollTime = performance.now();
        this._watchdogTimer = setInterval(() => this._watchdog(), 500);
        this._watchdogTripped = false;

        console.log('[VirtualJoy] Enabled');
    }

    disable() {
        if (!this._active && !this._readonly) return;
        this._active = false;
        this._readonly = false;

        document.removeEventListener('keydown', this._boundKeyDown);
        document.removeEventListener('keyup', this._boundKeyUp);

        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._watchdogTimer) {
            clearInterval(this._watchdogTimer);
            this._watchdogTimer = null;
        }

        // Reset state
        this._keysDown.clear();
        this._keyHoldTimers = {};
        this._throttleTouchId = null;
        this._steeringTouchId = null;

        console.log('[VirtualJoy] Disabled');
    }

    /** Show sliders as read-only indicators (for USB gamepad mode) */
    showReadonly() {
        this.disable();
        this._readonly = true;
        // Reset to neutral so visual doesn't show stale VJ state before first USB poll
        this._throttle = -1;
        this._steering = 0;
        this._updateThrottleVisual();
        this._updateSteeringVisual();
        this._dom.root.classList.add('vj-readonly');
        this.container.classList.add('vj-readonly-container');
    }

    /** Update slider visuals from external axes (USB gamepad passthrough) */
    setVisualAxes(throttle, steering) {
        this._throttle = throttle;
        this._steering = steering;
        this._updateThrottleVisual();
        this._updateSteeringVisual();
    }

    /** Update button visuals from external data (USB gamepad passthrough) */
    setVisualButtons(buttons) {
        // F1–F4 (indices 0–3)
        this._dom.funcButtons.forEach(btn => {
            const idx = parseInt(btn.dataset.index);
            if (idx < buttons.length) {
                btn.classList.toggle('active', !!buttons[idx]);
            }
        });
        // REV (index 4)
        if (buttons.length > 4) {
            this._reverseActive = !!buttons[4];
            this._dom.reverseBtn.classList.toggle('active', this._reverseActive);
        }
    }

    destroy() {
        this.disable();
        if (this.container && this._dom.root) {
            this.container.removeChild(this._dom.root);
        }
    }

    /** Emergency stop: zero throttle + steering, send immediately */
    emergencyStop() {
        this._throttle = -1;
        this._steering = 0;
        this._steeringDecaying = false;
        this._updateThrottleVisual();
        this._updateSteeringVisual();
        // Force send regardless of change detection
        const axes = [-1, 0];
        const buttons = this.buttons;
        this._lastAxes = axes.slice();
        this._lastButtons = buttons.slice();
        if (this.connection && this.connection.connected) {
            this.connection.sendJoy(axes, buttons);
        }
        if (this.onInput) this.onInput(axes, buttons);
        console.log('[VirtualJoy] EMERGENCY STOP');
    }

    // --- DOM Construction ---

    _buildDOM() {
        const root = document.createElement('div');
        root.className = 'vj-root';

        // Layout: throttle (left) | buttons (center) | steering (right)
        root.innerHTML = `
            <div class="vj-layout">
                <div class="vj-throttle-section">
                    <div class="vj-slider-label">THR</div>
                    <div class="vj-throttle-track" data-control="throttle">
                        <div class="vj-throttle-center-mark"></div>
                        <div class="vj-throttle-fill"></div>
                        <div class="vj-throttle-thumb"></div>
                    </div>
                    <div class="vj-slider-value vj-throttle-value">0%</div>
                </div>
                <div class="vj-buttons-section">
                    <div class="vj-btn-grid">
                        <button class="vj-btn vj-btn-func" data-index="0">F1</button>
                        <button class="vj-btn vj-btn-func" data-index="1">F2</button>
                        <button class="vj-btn vj-btn-func" data-index="2">F3</button>
                        <button class="vj-btn vj-btn-func" data-index="3">F4</button>
                    </div>
                    <button class="vj-btn vj-btn-reverse" data-index="4">REV</button>
                    <button class="vj-btn vj-btn-estop">STOP</button>
                </div>
                <div class="vj-steering-section">
                    <div class="vj-slider-label">STR</div>
                    <div class="vj-steering-track" data-control="steering">
                        <div class="vj-steering-center-mark"></div>
                        <div class="vj-steering-fill"></div>
                        <div class="vj-steering-thumb"></div>
                    </div>
                    <div class="vj-slider-value vj-steering-value">0.00</div>
                </div>
            </div>
            <div class="vj-key-hint">
                <span>W/S: Throttle</span>
                <span>A/D: Steering</span>
                <span>Space: Stop</span>
                <span>R: Reverse</span>
                <span>1-4: Func</span>
            </div>
            <div class="vj-watchdog-warning" style="display: none;">
                ⚠ INPUT FROZEN — Throttle zeroed for safety
            </div>
        `;

        this._dom.root = root;

        // Cache element references
        this._dom.throttleTrack = root.querySelector('.vj-throttle-track');
        this._dom.throttleFill = root.querySelector('.vj-throttle-fill');
        this._dom.throttleThumb = root.querySelector('.vj-throttle-thumb');
        this._dom.throttleValue = root.querySelector('.vj-throttle-value');

        this._dom.steeringTrack = root.querySelector('.vj-steering-track');
        this._dom.steeringFill = root.querySelector('.vj-steering-fill');
        this._dom.steeringThumb = root.querySelector('.vj-steering-thumb');
        this._dom.steeringValue = root.querySelector('.vj-steering-value');

        this._dom.funcButtons = root.querySelectorAll('.vj-btn-func');
        this._dom.reverseBtn = root.querySelector('.vj-btn-reverse');
        this._dom.estopBtn = root.querySelector('.vj-btn-estop');
        this._dom.watchdogWarning = root.querySelector('.vj-watchdog-warning');
        this._dom.keyHint = root.querySelector('.vj-key-hint');

        // Setup touch/mouse events
        this._setupThrottleTouch();
        this._setupSteeringTouch();
        this._setupButtons();

        this.container.appendChild(root);

        // Initialize visuals to match state (throttle starts at -1)
        this._updateThrottleVisual();
        this._updateSteeringVisual();
    }

    // --- Throttle Touch Handling ---

    _setupThrottleTouch() {
        const track = this._dom.throttleTrack;

        track.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (this._throttleTouchId !== null) return; // already tracking
            const touch = e.changedTouches[0];
            this._throttleTouchId = touch.identifier;
            this._updateThrottleFromTouch(touch);
        }, { passive: false });

        track.addEventListener('touchmove', (e) => {
            e.preventDefault();
            for (const touch of e.changedTouches) {
                if (touch.identifier === this._throttleTouchId) {
                    this._updateThrottleFromTouch(touch);
                    break;
                }
            }
        }, { passive: false });

        const endThrottle = (e) => {
            for (const touch of e.changedTouches) {
                if (touch.identifier === this._throttleTouchId) {
                    this._throttleTouchId = null;
                    // No spring-return — throttle stays
                    break;
                }
            }
        };
        track.addEventListener('touchend', endThrottle);
        track.addEventListener('touchcancel', endThrottle);

        // Mouse fallback (for desktop testing)
        let mouseDown = false;
        track.addEventListener('mousedown', (e) => {
            e.preventDefault();
            mouseDown = true;
            this._updateThrottleFromMouse(e);
        });
        document.addEventListener('mousemove', (e) => {
            if (mouseDown) this._updateThrottleFromMouse(e);
        });
        document.addEventListener('mouseup', () => {
            mouseDown = false;
            // No spring-return
        });
    }

    _updateThrottleFromTouch(touch) {
        const rect = this._dom.throttleTrack.getBoundingClientRect();
        const relY = (touch.clientY - rect.top) / rect.height; // 0=top, 1=bottom
        // Invert: top = +1, bottom = -1
        this._throttle = this._clamp(1 - 2 * relY, -1, 1);
        this._updateThrottleVisual();
    }

    _updateThrottleFromMouse(e) {
        const rect = this._dom.throttleTrack.getBoundingClientRect();
        const relY = (e.clientY - rect.top) / rect.height;
        this._throttle = this._clamp(1 - 2 * relY, -1, 1);
        this._updateThrottleVisual();
    }

    _updateThrottleVisual() {
        const val = this._throttle;
        // Compute inset from pill ends: border-radius / track-height as %
        const track = this._dom.throttleTrack;
        const radius = parseFloat(getComputedStyle(track).borderRadius) || 28;
        const height = track.clientHeight || 200;
        const inset = (radius / height) * 100;
        const range = 100 - 2 * inset;
        // Thumb position: map [-1,1] to [100%-inset, inset] top offset
        const raw = (1 - val) / 2;  // 0..1, top=0 bottom=1
        const pct = inset + raw * range;
        this._dom.throttleThumb.style.top = pct + '%';

        // Fill: from bottom up to current value (bottom = -1 = no power)
        this._dom.throttleFill.style.top = pct + '%';
        this._dom.throttleFill.style.bottom = '0%';
        this._dom.throttleFill.style.height = '';

        // Display as 0–100% (val: -1=0%, +1=100%)
        const displayPct = Math.round((val + 1) / 2 * 100);
        this._dom.throttleValue.textContent = displayPct + '%';
    }

    // --- Steering Touch Handling ---

    _setupSteeringTouch() {
        const track = this._dom.steeringTrack;

        track.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (this._steeringTouchId !== null) return;
            const touch = e.changedTouches[0];
            this._steeringTouchId = touch.identifier;
            this._updateSteeringFromTouch(touch);
        }, { passive: false });

        track.addEventListener('touchmove', (e) => {
            e.preventDefault();
            for (const touch of e.changedTouches) {
                if (touch.identifier === this._steeringTouchId) {
                    this._updateSteeringFromTouch(touch);
                    break;
                }
            }
        }, { passive: false });

        const endSteering = (e) => {
            for (const touch of e.changedTouches) {
                if (touch.identifier === this._steeringTouchId) {
                    this._steeringTouchId = null;
                    // Spring-return to center
                    this._steering = 0;
                    this._updateSteeringVisual();
                    break;
                }
            }
        };
        track.addEventListener('touchend', endSteering);
        track.addEventListener('touchcancel', endSteering);

        // Mouse fallback
        let mouseDown = false;
        track.addEventListener('mousedown', (e) => {
            e.preventDefault();
            mouseDown = true;
            this._updateSteeringFromMouse(e);
        });
        document.addEventListener('mousemove', (e) => {
            if (mouseDown) this._updateSteeringFromMouse(e);
        });
        document.addEventListener('mouseup', () => {
            if (mouseDown) {
                mouseDown = false;
                // Spring-return
                this._steering = 0;
                this._updateSteeringVisual();
            }
        });
    }

    _updateSteeringFromTouch(touch) {
        const rect = this._dom.steeringTrack.getBoundingClientRect();
        const relX = (touch.clientX - rect.left) / rect.width; // 0=left, 1=right
        this._steering = this._clamp(2 * relX - 1, -1, 1);
        this._updateSteeringVisual();
    }

    _updateSteeringFromMouse(e) {
        const rect = this._dom.steeringTrack.getBoundingClientRect();
        const relX = (e.clientX - rect.left) / rect.width;
        this._steering = this._clamp(2 * relX - 1, -1, 1);
        this._updateSteeringVisual();
    }

    _updateSteeringVisual() {
        const val = this._steering;
        // Compute inset from pill ends: border-radius / track-width as %
        const track = this._dom.steeringTrack;
        const radius = parseFloat(getComputedStyle(track).borderRadius) || 28;
        const width = track.clientWidth || 200;
        const inset = (radius / width) * 100;
        const range = 100 - 2 * inset;
        // Thumb position: map [-1,1] to [inset, 100%-inset] left offset
        const raw = (val + 1) / 2;  // 0..1, left=0 right=1
        const pct = inset + raw * range;
        this._dom.steeringThumb.style.left = pct + '%';

        // Fill: from center (50%) in the direction of the value
        if (val >= 0) {
            this._dom.steeringFill.style.left = '50%';
            this._dom.steeringFill.style.right = (100 - pct) + '%';
            this._dom.steeringFill.style.width = '';
        } else {
            this._dom.steeringFill.style.left = pct + '%';
            this._dom.steeringFill.style.right = '50%';
            this._dom.steeringFill.style.width = '';
        }

        this._dom.steeringValue.textContent = val.toFixed(2);
    }

    // --- Button Handling ---

    _setupButtons() {
        // Function buttons (momentary press)
        this._dom.funcButtons.forEach(btn => {
            const idx = parseInt(btn.dataset.index);

            const press = (e) => {
                e.preventDefault();
                this._buttons[idx] = 1;
                btn.classList.add('active');
            };
            const release = (e) => {
                e.preventDefault();
                this._buttons[idx] = 0;
                btn.classList.remove('active');
            };

            btn.addEventListener('touchstart', press, { passive: false });
            btn.addEventListener('touchend', release, { passive: false });
            btn.addEventListener('touchcancel', release, { passive: false });
            btn.addEventListener('mousedown', press);
            btn.addEventListener('mouseup', release);
            btn.addEventListener('mouseleave', release);
        });

        // Reverse toggle — use touchend with preventDefault to block the
        // subsequent click event on touch devices, and click for mouse users.
        let revTouched = false;
        this._dom.reverseBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            revTouched = true;
        }, { passive: false });
        this._dom.reverseBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            this._toggleReverse();
        });
        this._dom.reverseBtn.addEventListener('click', (e) => {
            e.preventDefault();
            // Only fire from mouse click, not from touch (touchend already handled it)
            if (revTouched) { revTouched = false; return; }
            this._toggleReverse();
        });

        // Emergency stop
        this._dom.estopBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.emergencyStop();
        });
        this._dom.estopBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.emergencyStop();
        }, { passive: false });
    }

    _toggleReverse() {
        this._reverseActive = !this._reverseActive;
        this._buttons[4] = this._reverseActive ? 1 : 0;
        this._dom.reverseBtn.classList.toggle('active', this._reverseActive);
    }

    // --- Keyboard Handling ---

    _onKeyDown(e) {
        if (!this._active) return;
        // Don't capture if user is typing in an input field
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

        const key = e.key.toLowerCase();

        // Space = emergency stop (same as STOP button)
        if (e.code === 'Space') {
            e.preventDefault();
            this.emergencyStop();
            return;
        }

        // Reverse toggle
        if (key === 'r' && !e.repeat) {
            e.preventDefault();
            this._toggleReverse();
            return;
        }

        // Function buttons (momentary)
        if (['1', '2', '3', '4'].includes(key) && !e.repeat) {
            e.preventDefault();
            const idx = parseInt(key) - 1;
            this._buttons[idx] = 1;
            this._dom.funcButtons[idx].classList.add('active');
            return;
        }

        // Axis keys
        const axisKey = this._getAxisKey(e);
        if (axisKey && !this._keysDown.has(axisKey)) {
            e.preventDefault();
            this._keysDown.add(axisKey);
            // Cancel steering decay if user presses a steering key
            if (axisKey === 'steer_left' || axisKey === 'steer_right') {
                this._steeringDecaying = false;
            }
            // Throttle: step only (incremental by 0.1, no continuous ramp)
            // Steering: continuous ramp only (no initial step)
            if (axisKey === 'steer_left' || axisKey === 'steer_right') {
                this._keyHoldTimers[axisKey] = {
                    startTime: 0, // no delay — ramp starts immediately
                    stepped: false,
                };
            } else {
                // Throttle: single step, no ramp timer
                this._applyKeyStep(axisKey);
            }
        } else if (axisKey) {
            e.preventDefault(); // prevent repeat default
        }
    }

    _onKeyUp(e) {
        if (!this._active) return;

        const key = e.key.toLowerCase();

        // Function buttons release
        if (['1', '2', '3', '4'].includes(key)) {
            const idx = parseInt(key) - 1;
            this._buttons[idx] = 0;
            this._dom.funcButtons[idx].classList.remove('active');
            return;
        }

        // Axis keys
        const axisKey = this._getAxisKey(e);
        if (axisKey) {
            this._keysDown.delete(axisKey);
            delete this._keyHoldTimers[axisKey];

            // Steering: start gradual decay toward center when no steering keys held
            if ((axisKey === 'steer_left' || axisKey === 'steer_right') &&
                !this._keysDown.has('steer_left') && !this._keysDown.has('steer_right')) {
                this._steeringDecaying = true;
            }
            // Throttle does NOT spring-return on key release
        }
    }

    _getAxisKey(e) {
        const key = e.key;
        if (key === 'w' || key === 'W' || key === 'ArrowUp') return 'throttle_up';
        if (key === 's' || key === 'S' || key === 'ArrowDown') return 'throttle_down';
        if (key === 'a' || key === 'A' || key === 'ArrowLeft') return 'steer_left';
        if (key === 'd' || key === 'D' || key === 'ArrowRight') return 'steer_right';
        return null;
    }

    _applyKeyStep(axisKey) {
        const step = this._KEY_STEP;
        if (axisKey === 'throttle_up') {
            this._throttle = this._clamp(this._throttle + step, -1, 1);
            this._updateThrottleVisual();
        } else if (axisKey === 'throttle_down') {
            this._throttle = this._clamp(this._throttle - step, -1, 1);
            this._updateThrottleVisual();
        } else if (axisKey === 'steer_left') {
            this._steering = this._clamp(this._steering - step, -1, 1);
            this._updateSteeringVisual();
        } else if (axisKey === 'steer_right') {
            this._steering = this._clamp(this._steering + step, -1, 1);
            this._updateSteeringVisual();
        }
    }

    _processKeyRamp() {
        const now = performance.now();
        const dt = 1.0 / this.pollRate; // seconds per tick
        const rampIncrement = this._RAMP_RATE * dt;

        for (const axisKey of this._keysDown) {
            const timer = this._keyHoldTimers[axisKey];
            if (!timer) continue;

            // Only ramp after hold delay
            if (now - timer.startTime < this._HOLD_DELAY) continue;

            // Only steering uses continuous ramp (throttle is step-only)
            if (axisKey === 'steer_left') {
                this._steering = this._clamp(this._steering - rampIncrement, -1, 1);
                this._updateSteeringVisual();
            } else if (axisKey === 'steer_right') {
                this._steering = this._clamp(this._steering + rampIncrement, -1, 1);
                this._updateSteeringVisual();
            }
        }
    }

    // --- Polling & Change Detection ---

    _poll() {
        this._lastPollTime = performance.now();

        // Process keyboard ramp (held keys)
        this._processKeyRamp();

        // Process steering decay (gradual return to center after keyboard release)
        if (this._steeringDecaying && this._steering !== 0) {
            const dt = 1.0 / this.pollRate;
            const decayAmount = this._STEERING_DECAY_RATE * dt;
            if (Math.abs(this._steering) <= decayAmount) {
                this._steering = 0;
                this._steeringDecaying = false;
            } else if (this._steering > 0) {
                this._steering -= decayAmount;
            } else {
                this._steering += decayAmount;
            }
            this._updateSteeringVisual();
        } else if (this._steeringDecaying && this._steering === 0) {
            this._steeringDecaying = false;
        }

        // Dismiss watchdog warning if we're polling again
        if (this._watchdogTripped) {
            this._watchdogTripped = false;
            this._dom.watchdogWarning.style.display = 'none';
        }

        const axes = this.axes;
        const buttons = this.buttons;

        // Always send — 50Hz is already rate-limited, server has per-client throttling
        if (this.connection && this.connection.connected) {
            this.connection.sendJoy(axes, buttons);
        }

        if (this.onInput) {
            this.onInput(axes, buttons);
        }
    }

    _hasChanged(axes, buttons) {
        if (axes.length !== this._lastAxes.length) return true;
        if (buttons.length !== this._lastButtons.length) return true;

        for (let i = 0; i < axes.length; i++) {
            if (Math.abs(axes[i] - (this._lastAxes[i] || 0)) > this.deadzone) return true;
        }
        for (let i = 0; i < buttons.length; i++) {
            if (buttons[i] !== this._lastButtons[i]) return true;
        }
        return false;
    }

    // --- Safety Watchdog ---

    _watchdog() {
        if (!this._active) return;

        const elapsed = performance.now() - this._lastPollTime;
        if (elapsed > 500) {
            // Poll timer hasn't fired for 500ms — JS event loop is frozen or tab backgrounded
            if (!this._watchdogTripped) {
                this._watchdogTripped = true;
                console.warn('[VirtualJoy] WATCHDOG: Poll timer stalled for %dms, zeroing throttle', Math.round(elapsed));
                this._dom.watchdogWarning.style.display = '';

                // Send safe values immediately (throttle to minimum)
                this._throttle = -1;
                this._steering = 0;
                this._steeringDecaying = false;
                this._updateThrottleVisual();
                this._updateSteeringVisual();
                if (this.connection && this.connection.connected) {
                    this.connection.sendJoy([-1, 0], this.buttons);
                }
            }
        }
    }

    // --- Utilities ---

    _clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    _roundAxis(val) {
        if (Math.abs(val) < this.deadzone) return 0;
        return Math.round(val * 10000) / 10000;
    }
}
