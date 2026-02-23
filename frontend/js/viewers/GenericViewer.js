/**
 * Generic Viewer — rosboard-style JSON table display
 *
 * Renders any ROS2 message as a two-column table (field → value).
 * Nested messages are shown with indentation and collapsible rows.
 * Matches all message types via the "*" wildcard.
 */

class GenericViewer extends Viewer {
    static get supportedTypes() { return ['*']; }
    static get friendlyName() { return 'Generic'; }
    static get maxUpdateRate() { return 10; }

    onCreate(contentEl) {
        this.tableEl = document.createElement('table');
        this.tableEl.className = 'viewer-table';
        contentEl.appendChild(this.tableEl);
        this._collapsed = {};  // track collapsed paths
        this._lastMsg = null;  // store last message for re-render on collapse toggle
    }

    onData(msg) {
        this._lastMsg = msg;
        this._render();
    }

    /** Rebuild the table from the last received message. */
    _render() {
        if (!this._lastMsg) return;
        this.tableEl.innerHTML = '';
        this._renderObject(this._lastMsg, '', 0);
    }

    /**
     * Recursively render an object as table rows.
     * @param {*} obj        — value to render
     * @param {string} path  — dot-separated path for collapse tracking
     * @param {number} depth — indentation level
     */
    _renderObject(obj, path, depth) {
        if (obj === null || obj === undefined) {
            this._addRow(path, path.split('.').pop() || '(root)', this._formatValue(obj), depth);
            return;
        }

        if (typeof obj !== 'object' || Array.isArray(obj)) {
            // Leaf value — shouldn't normally be called at top level
            this._addRow(path, path.split('.').pop() || '', this._formatValue(obj), depth);
            return;
        }

        const keys = Object.keys(obj);
        for (const key of keys) {
            // Skip internal metadata fields
            if (key.startsWith('_')) continue;

            const val = obj[key];
            const childPath = path ? path + '.' + key : key;

            if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
                // Nested object — collapsible header row
                const isCollapsed = this._collapsed[childPath] || false;
                this._addGroupRow(childPath, key, isCollapsed, depth);
                if (!isCollapsed) {
                    this._renderObject(val, childPath, depth + 1);
                }
            } else {
                // Leaf value (primitive or array)
                this._addRow(childPath, key, this._formatValue(val), depth);
            }
        }
    }

    /** Add a collapsible group header row. */
    _addGroupRow(path, label, collapsed, depth) {
        const tr = document.createElement('tr');
        tr.className = 'viewer-group-row';
        tr.style.cursor = 'pointer';

        const tdName = document.createElement('td');
        tdName.className = 'viewer-field';
        tdName.style.paddingLeft = (8 + depth * 16) + 'px';
        tdName.innerHTML = `<span class="viewer-collapse-icon">${collapsed ? '▶' : '▼'}</span> ${this._escapeHtml(label)}`;
        tdName.colSpan = 2;

        tr.appendChild(tdName);
        tr.addEventListener('click', (e) => {
            e.stopPropagation();
            this._collapsed[path] = !this._collapsed[path];
            this._render();
        });

        this.tableEl.appendChild(tr);
    }

    /** Add a leaf field → value row. */
    _addRow(path, label, formattedValue, depth) {
        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        tdName.className = 'viewer-field';
        tdName.style.paddingLeft = (8 + depth * 16) + 'px';
        tdName.textContent = label;

        const tdVal = document.createElement('td');
        tdVal.className = 'viewer-value';
        tdVal.innerHTML = formattedValue;

        tr.appendChild(tdName);
        tr.appendChild(tdVal);
        this.tableEl.appendChild(tr);
    }

    /** Format a leaf value for display. */
    _formatValue(val) {
        if (val === null || val === undefined) {
            return '<span class="viewer-null">null</span>';
        }
        if (typeof val === 'boolean') {
            return `<span class="viewer-bool-${val}">${val}</span>`;
        }
        if (typeof val === 'number') {
            // Round floats for readability
            if (!Number.isInteger(val)) {
                return '<span class="viewer-number">' + val.toFixed(6) + '</span>';
            }
            return '<span class="viewer-number">' + val + '</span>';
        }
        if (typeof val === 'string') {
            return '<span class="viewer-string">"' + this._escapeHtml(val) + '"</span>';
        }
        if (Array.isArray(val)) {
            if (val.length === 0) return '<span class="viewer-array">[]</span>';
            if (val.length <= 8) {
                // Short array — show inline
                const items = val.map(v => {
                    if (typeof v === 'number' && !Number.isInteger(v)) return v.toFixed(4);
                    return String(v);
                });
                return '<span class="viewer-array">[' + this._escapeHtml(items.join(', ')) + ']</span>';
            }
            // Long array — show length and first few
            const preview = val.slice(0, 4).map(v => {
                if (typeof v === 'number' && !Number.isInteger(v)) return v.toFixed(4);
                return String(v);
            });
            return '<span class="viewer-array">[' + this._escapeHtml(preview.join(', ')) +
                   ', … <span class="viewer-dim">(' + val.length + ' items)</span>]</span>';
        }
        return this._escapeHtml(String(val));
    }

    _escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}

Viewer.registerViewer(GenericViewer);
