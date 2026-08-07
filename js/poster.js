/**
 * Poster — cartographic chrome over the map: a title block and a legend box,
 * so a finished operation plan reads as a published product rather than
 * annotations on a screenshot.
 *
 * Both panels are appended to the Leaflet container (map.getContainer()), NOT to
 * .map-container. That matters: the MCP screenshot tool clips to #map, so chrome
 * placed as a sibling of #map — the way #date is — would be cropped out of every
 * capture.
 *
 * The legend is derived from what is actually drawn, so it cannot silently drift
 * away from the map; explicit rows from the caller override the derived ones.
 */
class Poster {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.visible = false;
        this.title = null;      // { title, subtitle, dateline, caveat }
        this.legend = null;     // { auto, title, rows, hide }
        this._els = {};
    }

    // ── public API ──────────────────────────────────────────

    setTitle(cfg) {
        this.title = cfg && (cfg.title || cfg.subtitle || cfg.dateline || cfg.caveat) ? { ...cfg } : null;
        this.visible = true;
        this.render();
        return this.serialize();
    }

    setLegend(cfg) {
        this.legend = cfg && cfg.hide ? null : { auto: true, ...cfg };
        this.visible = true;
        this.render();
        return this.serialize();
    }

    show(on = true) {
        this.visible = !!on;
        this.render();
        return this.serialize();
    }

    clear() {
        this.title = null;
        this.legend = null;
        this.visible = false;
        this.render();
        return this.serialize();
    }

    serialize() {
        return { visible: this.visible, title: this.title, legend: this.legend };
    }

    restore(state) {
        if (!state) return this.clear();
        this.visible = !!state.visible;
        this.title = state.title || null;
        this.legend = state.legend || null;
        this.render();
        return this.serialize();
    }

    // ── rendering ───────────────────────────────────────────

    render() {
        this._renderTitle();
        this._renderLegend();
        // the app's own date pill sits top-centre and competes with the title block;
        // the poster carries its own dateline instead
        const date = this.dashboard.getEl('date');
        if (date) {
            if (this.visible && this.title) {
                if (this._dateWas === undefined) this._dateWas = date.style.display;
                date.style.display = 'none';
            } else if (this._dateWas !== undefined) {
                date.style.display = this._dateWas;
                this._dateWas = undefined;
            }
        }
    }

    _panel(key, className) {
        if (this._els[key]) return this._els[key];
        const el = document.createElement('div');
        el.className = className;
        this.dashboard.map.getContainer().appendChild(el);
        this._els[key] = el;
        return el;
    }

    _renderTitle() {
        const el = this._panel('title', 'poster-title');
        if (!this.visible || !this.title) { el.style.display = 'none'; el.innerHTML = ''; return; }

        const { title, subtitle, dateline, caveat } = this.title;
        el.style.display = '';
        el.innerHTML = [
            dateline ? `<div class="poster-dateline">${esc(dateline)}</div>` : '',
            title ? `<div class="poster-heading">${esc(title)}</div>` : '',
            subtitle ? `<div class="poster-subheading">${esc(subtitle)}</div>` : '',
            caveat ? `<div class="poster-caveat">${esc(caveat)}</div>` : '',
        ].join('');
    }

    _renderLegend() {
        const el = this._panel('legend', 'poster-legend');
        if (!this.visible || !this.legend) { el.style.display = 'none'; el.innerHTML = ''; return; }

        const rows = this._resolveRows();
        if (!rows.length) { el.style.display = 'none'; el.innerHTML = ''; return; }

        el.style.display = '';
        el.innerHTML =
            (this.legend.title ? `<div class="poster-legend-title">${esc(this.legend.title)}</div>` : '') +
            rows.map(r => `<div class="poster-legend-row">${this._swatch(r)}<span>${esc(r.label)}</span></div>`).join('');
    }

    /**
     * Overrides are matched to derived rows by `match` (the derived default label),
     * NOT by position — positional matching silently pairs a label with the wrong
     * swatch as soon as the drawing order changes.
     *
     * A row with `match` renames/restyles/hides that derived row; a row with its own
     * type/icon/color stands alone. Output order follows the supplied rows, then any
     * derived rows that were not matched.
     */
    _resolveRows() {
        const explicit = Array.isArray(this.legend.rows) ? this.legend.rows : [];
        if (this.legend.auto === false) return explicit.filter(r => r.label && !r.hide);

        const derived = this._deriveRows();
        const byLabel = new Map(derived.map((d, i) => [d.label.toLowerCase(), i]));
        const used = new Set();
        const out = [];

        for (const r of explicit) {
            if (r.match) {
                const i = byLabel.get(String(r.match).toLowerCase());
                if (i === undefined) continue;          // nothing drawn matches it
                used.add(i);
                if (r.hide) continue;
                out.push({ ...derived[i], ...r, label: r.label || derived[i].label });
            } else if (r.type || r.icon) {
                out.push(r);                            // standalone row, own swatch
            } else if (r.label) {
                out.push(r);                            // label-only row, generic swatch
            }
        }

        derived.forEach((d, i) => { if (!used.has(i)) out.push(d); });
        return out.filter(r => r.label && !r.hide);
    }

    /** One row per distinct visual style currently drawn on the map. */
    _deriveRows() {
        const shapes = this.dashboard.drawTool?.shapes || [];
        const seen = new Map();

        for (const s of shapes) {
            if (s.type === 'text') continue;   // labels describe themselves
            const key = [s.type, s.color, !!s.dash, !!s.fill, s.pattern || '', s.icon || '', !!s.taper].join('|');
            if (seen.has(key)) { seen.get(key).count++; continue; }
            seen.set(key, {
                count: 1,
                type: s.type,
                color: s.color,
                dash: !!s.dash,
                fill: !!s.fill,
                pattern: s.pattern || null,
                icon: s.icon || null,
                taper: !!s.taper,
                label: this._defaultLabel(s),
            });
        }
        return [...seen.values()];
    }

    _defaultLabel(s) {
        const side = Poster.SIDE_BY_COLOR[(s.color || '').toLowerCase()] || '';
        const kind =
            s.type === 'icon'                     ? (s.icon || 'icon').replace(/_/g, ' ') :
            s.type === 'polygon' && s.fill        ? 'area' :
            s.type === 'polygon'                  ? 'outline' :
            s.type === 'arrow' || s.type === 'arc' || s.type === 'freedraw' ? 'axis of advance' :
            s.type === 'line'                     ? (s.dash ? 'phase line' : 'line') :
            s.type === 'ellipse' || s.type === 'rect' ? 'position' :
            s.type;
        return [side, kind].filter(Boolean).join(' ').replace(/^./, c => c.toUpperCase());
    }

    /** Swatch drawn to match how the shape actually renders on the map. */
    _swatch(r) {
        const color = r.color || '#666';
        if (r.type === 'icon' && r.icon) {
            return `<img class="poster-swatch" src="images/events/${esc(r.icon)}.png" alt="">`;
        }
        if (r.type === 'polygon' || r.type === 'ellipse' || r.type === 'rect') {
            const bg = r.fill
                ? (r.pattern && r.pattern !== 'solid'
                    ? `background:${Poster.patternCss(r.pattern, color)};`
                    : `background:${color};opacity:.85;`)
                : '';
            const dash = r.dash ? 'border-style:dashed;' : '';
            return `<span class="poster-swatch poster-swatch-area" style="border-color:${color};${dash}${bg}"></span>`;
        }
        if (r.type === 'arrow' || r.type === 'arc' || r.type === 'freedraw') {
            return `<span class="poster-swatch poster-swatch-arrow" style="color:${color}">
                <svg viewBox="0 0 24 10" width="24" height="10"><path d="M1 5 H17" stroke="currentColor"
                stroke-width="${r.taper ? 4 : 2.5}" stroke-linecap="round"${r.dash ? ' stroke-dasharray="5 3"' : ''}/>
                <path d="M15 1.5 L22 5 L15 8.5 Z" fill="currentColor"/></svg></span>`;
        }
        const dash = r.dash ? 'border-top-style:dashed;' : '';
        return `<span class="poster-swatch poster-swatch-line" style="border-top-color:${color};${dash}"></span>`;
    }

    /** CSS repeating-gradient mirroring DrawingTool's canvas hatch patterns. */
    static patternCss(kind, color) {
        if (kind === 'dots') return `radial-gradient(${color} 1.4px, transparent 1.5px) 0 0/6px 6px`;
        const stripes = `repeating-linear-gradient(45deg, ${color} 0 1.5px, transparent 1.5px 6px)`;
        if (kind === 'crosshatch') {
            return `${stripes}, repeating-linear-gradient(-45deg, ${color} 0 1.5px, transparent 1.5px 6px)`;
        }
        return stripes;
    }
}

// Matches MapUMLEngine.colors, which is what the MCP draw tools use.
Poster.SIDE_BY_COLOR = {
    '#d0021b': 'Russian',
    '#4a90e2': 'Ukrainian',
    '#f5a623': '',
};

function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

window.Poster = Poster;
