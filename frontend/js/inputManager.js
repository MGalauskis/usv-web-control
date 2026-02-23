/**
 * Input Manager
 *
 * Arbitrates between USB gamepad (JoystickCapture) and
 * VirtualJoystick (touch/keyboard). They are mutually exclusive:
 *   - USB gamepad takes priority if connected.
 *   - Virtual joystick activates when no gamepad is present.
 *
 * Provides a single unified callback interface to the app.
 */

class InputManager {
    constructor(connection) {
        this.connection = connection;

        // Create both input sources
        // VirtualJoystick container is set later via setVirtualContainer()
        this._joystick = new JoystickCapture(connection);
        this._virtual = null;  // created when container is set
        this._virtualContainer = null;

        // State
        this._activeSource = 'none'; // 'usb' | 'virtual' | 'none'
        this._throttleAxisTouched = false; // axis 6 reports 0 until physically moved

        // Callbacks (set by app.js)
        this.onStateChange = null;    // (axes, buttons, source, deviceName)
        this.onSourceSwitch = null;   // (newSource, deviceName)

        // USB gamepad remapping:
        //
        // Axes:
        //   Gamepad axis 6 → protocol axes[0] (THR) — raw value passed through
        //   Gamepad axis 0 → protocol axes[1] (STR)
        //   NOTE: axis 6 is inverted on the gamepad (-1 = max throttle, +1 = min)
        //         The raw value is sent as-is; visual inversion handled in app.js
        //
        // Buttons:
        //   Gamepad B0 → protocol buttons[4] (REV)
        //   Gamepad B1 → protocol buttons[0] (F1)
        //   Gamepad B2 → protocol buttons[1] (F2)
        //   Gamepad B3 → protocol buttons[2] (F3)
        //   Gamepad B4 → protocol buttons[3] (F4)
        //   Remaining mapped to buttons[5..7]

        // Wire up USB gamepad callbacks
        this._joystick.onGamepadConnect = (gp) => this._onGamepadConnect(gp);
        this._joystick.onGamepadDisconnect = (gp) => this._onGamepadDisconnect(gp);
        this._joystick.onStateChange = (axes, buttons, gpId) => {
            if (this._activeSource === 'usb') {
                const mappedAxes = this._remapAxes(axes);
                const mappedButtons = this._remapButtons(buttons);
                // Always send — 50Hz is already rate-limited, server has per-client throttling
                if (this.connection && this.connection.connected) {
                    this.connection.sendJoy(mappedAxes, mappedButtons);
                }
                if (this.onStateChange) this.onStateChange(mappedAxes, mappedButtons, 'usb', gpId);
            }
        };
    }

    get activeSource() {
        return this._activeSource;
    }

    get usbConnected() {
        return this._joystick.connected;
    }

    /**
     * Set the DOM container for the virtual joystick.
     * Must be called before start().
     */
    setVirtualContainer(containerEl) {
        this._virtualContainer = containerEl;
        this._virtual = new VirtualJoystick(containerEl, this.connection, {
            onInput: (axes, buttons) => {
                if (this._activeSource === 'virtual') {
                    if (this.onStateChange) this.onStateChange(axes, buttons, 'virtual', 'Virtual Joystick');
                }
            },
        });
    }

    start() {
        // Start USB gamepad polling (always runs for detection)
        this._joystick.start();

        // Determine initial source
        if (this._joystick.connected) {
            this._switchToUSB();
        } else {
            this._switchToVirtual();
        }
    }

    stop() {
        this._joystick.stop();
        if (this._virtual) this._virtual.disable();
        this._activeSource = 'none';
    }

    /** Get the VirtualJoystick instance (for fullscreen overlay use) */
    getVirtualJoystick() {
        return this._virtual;
    }

    /** Force emergency stop on whichever source is active */
    emergencyStop() {
        if (this._virtual) {
            this._virtual.emergencyStop();
        } else {
            // For USB, send stop directly
            if (this.connection && this.connection.connected) {
                this.connection.sendJoy([-1, 0], [0, 0, 0, 0, 0, 0, 0, 0]);
            }
        }
    }

    // --- Internal switching ---

    _switchToUSB() {
        if (this._activeSource === 'usb') return;
        this._activeSource = 'usb';

        // Switch VJ to read-only visual mode, un-suppress USB
        if (this._virtual) this._virtual.showReadonly();
        this._joystick.suppress = false;

        console.log('[InputManager] Switched to USB gamepad');
        if (this.onSourceSwitch) this.onSourceSwitch('usb', this._getGamepadName());
    }

    _switchToVirtual() {
        if (this._activeSource === 'virtual') return;
        if (!this._virtual) {
            console.warn('[InputManager] No virtual joystick container set');
            return;
        }
        this._activeSource = 'virtual';

        // Suppress USB output (still polls for detection), enable virtual
        this._joystick.suppress = true;
        this._virtual.enable();

        console.log('[InputManager] Switched to Virtual joystick');
        if (this.onSourceSwitch) this.onSourceSwitch('virtual', 'Virtual Joystick');
    }

    _onGamepadConnect(gp) {
        console.log('[InputManager] Gamepad connected:', gp.id);
        this._switchToUSB();
    }

    _onGamepadDisconnect(gp) {
        console.log('[InputManager] Gamepad disconnected:', gp.id);
        this._throttleAxisTouched = false;
        // Check if any gamepads remain
        if (!this._joystick.connected) {
            this._switchToVirtual();
        }
    }

    /**
     * Remap USB gamepad axes to the protocol layout:
     *   Gamepad axis 6 → axes[0] (THR) — raw value, not inverted
     *   Gamepad axis 0 → axes[1] (STR)
     *
     * Axis 6 reports 0 until physically moved for the first time.
     * Treat it as +1 (no throttle) until it leaves the 0 position.
     */
    _remapAxes(raw) {
        let throttle = raw.length > 6 ? raw[6] : 0;
        if (!this._throttleAxisTouched) {
            if (Math.abs(throttle) > 0.01) {
                this._throttleAxisTouched = true;
            } else {
                throttle = 1; // rest = no throttle
            }
        }
        return [
            throttle,                      // THR from axis 6
            raw.length > 0 ? raw[0] : 0,  // STR from axis 0
        ];
    }

    /**
     * Remap USB gamepad buttons to the protocol layout:
     *   Gamepad B0 → buttons[4] (REV)
     *   Gamepad B1 → buttons[0] (F1)
     *   Gamepad B2 → buttons[1] (F2)
     *   Gamepad B3 → buttons[2] (F3)
     *   Gamepad B4 → buttons[3] (F4)
     *   Gamepad B5+ → buttons[5..7]
     */
    _remapButtons(raw) {
        const mapped = new Array(8).fill(0);
        if (raw.length > 0) mapped[4] = raw[0]; // B0 → REV
        if (raw.length > 1) mapped[0] = raw[1]; // B1 → F1
        if (raw.length > 2) mapped[1] = raw[2]; // B2 → F2
        if (raw.length > 3) mapped[2] = raw[3]; // B3 → F3
        if (raw.length > 4) mapped[3] = raw[4]; // B4 → F4
        // Pass remaining buttons to slots 5–7
        for (let i = 5; i < raw.length && i < 8; i++) {
            mapped[i] = raw[i];
        }
        return mapped;
    }

    _getGamepadName() {
        if (this._joystick.gamepadIndex !== null) {
            const gp = navigator.getGamepads()[this._joystick.gamepadIndex];
            return gp ? gp.id : 'USB Gamepad';
        }
        return 'USB Gamepad';
    }
}
