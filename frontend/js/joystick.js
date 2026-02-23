/**
 * Joystick Capture Module
 *
 * Uses the browser Gamepad API to read USB joystick input
 * and sends it to the USV via the WebSocket connection.
 *
 * Features:
 *  - Polls at configurable rate (default 50Hz)
 *  - Only sends data when axes/buttons change (deadzone filtering)
 *  - Supports multiple gamepads (uses first connected by default)
 *  - Visual feedback of joystick state
 */

class JoystickCapture {
    constructor(connection) {
        this.connection = connection;
        this.pollRate = 50;  // Hz
        this.deadzone = 0.05;
        this.active = false;
        this.suppress = false;  // when true, still polls for detection but doesn't send data
        this.pollTimer = null;
        this.gamepadIndex = null;

        // Last sent state (for change detection)
        this.lastAxes = [];
        this.lastButtons = [];

        // Current state (for UI)
        this.currentAxes = [];
        this.currentButtons = [];
        this.connected = false;

        // Callbacks for UI updates
        this.onStateChange = null;
        this.onGamepadConnect = null;
        this.onGamepadDisconnect = null;

        this._setupEvents();
    }

    _setupEvents() {
        window.addEventListener('gamepadconnected', (e) => {
            console.log('[Joystick] Connected:', e.gamepad.id);
            if (this.gamepadIndex === null) {
                this.gamepadIndex = e.gamepad.index;
            }
            this.connected = true;
            if (this.onGamepadConnect) this.onGamepadConnect(e.gamepad);
        });

        window.addEventListener('gamepaddisconnected', (e) => {
            console.log('[Joystick] Disconnected:', e.gamepad.id);
            if (e.gamepad.index === this.gamepadIndex) {
                this.gamepadIndex = null;
                this.connected = false;
                // Try to find another gamepad (skip the one being disconnected)
                const gamepads = navigator.getGamepads();
                for (let i = 0; i < gamepads.length; i++) {
                    if (gamepads[i] && gamepads[i].index !== e.gamepad.index) {
                        this.gamepadIndex = i;
                        this.connected = true;
                        break;
                    }
                }
            }
            if (this.onGamepadDisconnect) this.onGamepadDisconnect(e.gamepad);
        });
    }

    start() {
        if (this.active) return;
        this.active = true;
        this.pollTimer = setInterval(() => this._poll(), 1000 / this.pollRate);
        console.log('[Joystick] Capture started at %d Hz', this.pollRate);
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        console.log('[Joystick] Capture stopped');
    }

    _poll() {
        const gamepads = navigator.getGamepads();
        if (this.gamepadIndex === null || !gamepads[this.gamepadIndex] || !gamepads[this.gamepadIndex].connected) {
            if (this.gamepadIndex !== null) {
                // Active gamepad disappeared — mark disconnected
                this.gamepadIndex = null;
                this.connected = false;
            }
            // Check if a new gamepad appeared
            for (let i = 0; i < gamepads.length; i++) {
                if (gamepads[i] && gamepads[i].connected) {
                    this.gamepadIndex = i;
                    this.connected = true;
                    if (this.onGamepadConnect) this.onGamepadConnect(gamepads[i]);
                    break;
                }
            }
            if (this.gamepadIndex === null) return;
        }

        const gp = gamepads[this.gamepadIndex];
        if (!gp) return;

        // Read axes with deadzone
        const axes = [];
        for (let i = 0; i < gp.axes.length; i++) {
            let val = gp.axes[i];
            if (Math.abs(val) < this.deadzone) val = 0.0;
            axes.push(Math.round(val * 10000) / 10000);  // 4 decimal places
        }

        // Read buttons
        const buttons = [];
        for (let i = 0; i < gp.buttons.length; i++) {
            buttons.push(gp.buttons[i].pressed ? 1 : 0);
        }

        this.currentAxes = axes;
        this.currentButtons = buttons;

        // When suppressed, still track state for detection but don't send or callback
        if (this.suppress) return;

        // InputManager handles change detection and WebSocket sending after remapping
        if (this.onStateChange) {
            this.onStateChange(axes, buttons, gp.id);
        }
    }

    _hasChanged(axes, buttons) {
        if (axes.length !== this.lastAxes.length) return true;
        if (buttons.length !== this.lastButtons.length) return true;

        for (let i = 0; i < axes.length; i++) {
            if (Math.abs(axes[i] - (this.lastAxes[i] || 0)) > this.deadzone) return true;
        }
        for (let i = 0; i < buttons.length; i++) {
            if (buttons[i] !== this.lastButtons[i]) return true;
        }
        return false;
    }
}
