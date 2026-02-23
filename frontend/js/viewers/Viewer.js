/**
 * Base Viewer class (rosboard-inspired)
 *
 * Provides a card UI container and a polymorphic registry so that
 * type-specific viewers can be registered and selected at runtime.
 *
 * Subclasses override:
 *   onCreate(contentEl)  — build DOM inside the card's content area
 *   onData(msg)          — render a new ROS2 message dict
 *
 * Usage:
 *   Viewer.registerViewer(GenericViewer);
 *   const ViewerClass = Viewer.getViewerForType("sensor_msgs/msg/Imu");
 *   const v = new ViewerClass(container, topicName, topicType, { onClose });
 */

class Viewer {
    // --- Static viewer registry ---
    static _registry = [];

    static registerViewer(cls) {
        Viewer._registry.push(cls);
    }

    /**
     * Return the best viewer class for a given ROS2 message type.
     * Checks supportedTypes on each registered viewer; falls back to
     * the wildcard "*" viewer (GenericViewer).
     */
    static getViewerForType(msgType) {
        let fallback = null;
        for (const cls of Viewer._registry) {
            const types = cls.supportedTypes || [];
            if (types.includes(msgType)) return cls;
            if (types.includes('*')) fallback = cls;
        }
        return fallback;
    }

    // --- Instance ---

    /**
     * @param {HTMLElement} container  — parent element to append card into
     * @param {string} topicName       — e.g. "/imu/data"
     * @param {string} topicType       — e.g. "sensor_msgs/msg/Imu"
     * @param {object} opts
     * @param {function} opts.onClose  — called when user clicks close
     */
    constructor(container, topicName, topicType, opts = {}) {
        this.container = container;
        this.topicName = topicName;
        this.topicType = topicType;
        this.onClose = opts.onClose || null;

        this.paused = false;
        this.lastUpdateTime = 0;
        this.minInterval = 1000 / (this.constructor.maxUpdateRate || 24);

        this._buildCard();
        this.onCreate(this.contentEl);
    }

    /** Build the card DOM structure. */
    _buildCard() {
        this.cardEl = document.createElement('div');
        this.cardEl.className = 'viewer-card';
        this.cardEl.draggable = true;
        this.cardEl.dataset.topicName = this.topicName;
        this._setupDragDrop();

        // Header
        const header = document.createElement('div');
        header.className = 'viewer-header';

        const titleArea = document.createElement('div');
        titleArea.className = 'viewer-title-area';

        const name = document.createElement('span');
        name.className = 'viewer-topic-name';
        name.textContent = this.topicName;

        const type = document.createElement('span');
        type.className = 'viewer-topic-type';
        type.textContent = this.topicType;

        titleArea.appendChild(name);
        titleArea.appendChild(type);

        // Buttons
        const btnGroup = document.createElement('div');
        btnGroup.className = 'viewer-btn-group';

        this.pauseBtn = document.createElement('button');
        this.pauseBtn.className = 'viewer-btn';
        this.pauseBtn.textContent = '⏸';
        this.pauseBtn.title = 'Pause';
        this.pauseBtn.addEventListener('click', () => this.togglePause());

        const closeBtn = document.createElement('button');
        closeBtn.className = 'viewer-btn viewer-btn-close';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', () => {
            if (this.onClose) this.onClose(this.topicName);
        });

        btnGroup.appendChild(this.pauseBtn);
        btnGroup.appendChild(closeBtn);

        header.appendChild(titleArea);
        header.appendChild(btnGroup);

        // Content area (subclass renders here)
        this.contentEl = document.createElement('div');
        this.contentEl.className = 'viewer-content';

        this.cardEl.appendChild(header);
        this.cardEl.appendChild(this.contentEl);
        this.container.appendChild(this.cardEl);
    }

    /** Set up HTML5 drag-and-drop for card reordering. */
    _setupDragDrop() {
        const card = this.cardEl;

        card.addEventListener('dragstart', (e) => {
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', this.topicName);
        });

        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            // Clean up any lingering drop indicators
            for (const c of this.container.querySelectorAll('.viewer-card')) {
                c.classList.remove('drag-over');
            }
        });

        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const dragging = this.container.querySelector('.dragging');
            if (dragging && dragging !== card) {
                card.classList.add('drag-over');
            }
        });

        card.addEventListener('dragleave', () => {
            card.classList.remove('drag-over');
        });

        card.addEventListener('drop', (e) => {
            e.preventDefault();
            card.classList.remove('drag-over');
            const dragging = this.container.querySelector('.dragging');
            if (dragging && dragging !== card) {
                // Swap positions: use a placeholder to avoid losing reference
                const parent = card.parentNode;
                const placeholder = document.createElement('div');
                parent.insertBefore(placeholder, dragging);
                parent.insertBefore(dragging, card);
                parent.insertBefore(card, placeholder);
                parent.removeChild(placeholder);
            }
        });
    }

    /** Rate-limited entry point. Called by app.js on each incoming message. */
    update(msg) {
        if (this.paused) return;
        const now = Date.now();
        if (now - this.lastUpdateTime < this.minInterval) return;
        this.lastUpdateTime = now;
        this.onData(msg);
    }

    togglePause() {
        this.paused = !this.paused;
        this.pauseBtn.textContent = this.paused ? '▶' : '⏸';
        this.pauseBtn.title = this.paused ? 'Resume' : 'Pause';
        this.cardEl.classList.toggle('paused', this.paused);
    }

    /** Remove card from DOM. */
    destroy() {
        if (this.cardEl && this.cardEl.parentNode) {
            this.cardEl.parentNode.removeChild(this.cardEl);
        }
    }

    // --- Subclass overrides ---

    /** Called once after card is created. Build your DOM inside contentEl. */
    onCreate(contentEl) {}

    /** Called on each (rate-limited) incoming message. */
    onData(msg) {}
}
