// Zone eraser brush — paint over an area to strip it back to bare, burnt ground:
// trees vanish, buildings collapse into rubble, and the soil is scorched. For
// depicting a razed village or a cleared field of fire.
//
// Nothing here is destructive in the data sense: hidden trees keep their original
// instance matrices, buildings go through the same staged-destruction path the Destroy
// tool uses, and scorch is just dabs in a canvas. One drag is one undo step.

const TREE_RADIUS_K = 1.0;      // trees are cleared over the full brush
const BUILDING_RADIUS_K = 0.9;  // buildings need their centre well inside, or a brush
                                // edge clipping a corner would flatten a whole block
const SCORCH_COLOR = '38, 30, 24';

export class Eraser {
    /**
     * @param {object} deps { vegetation, buildings, damage, scorch } — `scorch` is a
     *   TerrainPaint layer, `damage` the Damage instance owning building state.
     */
    constructor({ vegetation, buildings, damage, scorch }) {
        this.vegetation = vegetation;
        this.buildings = buildings;
        this.damage = damage;
        this.scorch = scorch;
        this.stroke = null;
        // Every dab ever applied, as {x, z, r}. This — not the tree indices — is what
        // gets saved: the vegetation scatter is re-randomised on each load, so replaying
        // the *area* restores the same cleared zone while replaying indices would clear
        // an essentially random set of trees.
        this.circles = [];
    }

    // ── one drag = one stroke = one undo entry ──────────────────────────────

    begin() {
        this.stroke = { trees: [], buildings: [], dabs: 0 };
    }

    /**
     * Apply the brush at a terrain point. Accumulates into the open stroke.
     * @returns {boolean} whether anything changed
     */
    dab(x, z, radius, record = true) {
        if (!this.stroke) this.begin();
        let changed = false;
        if (record) this.circles.push({ x, z, r: radius });

        if (this.vegetation?.placements?.length) {
            const hits = this.vegetation
                .treesWithin(x, z, radius * TREE_RADIUS_K)
                .filter(i => !this.vegetation.hidden.has(i));
            if (hits.length) {
                this.vegetation.setHidden(hits, true);
                this.stroke.trees.push(...hits);
                changed = true;
            }
        }

        if (this.buildings?.records?.length && this.damage) {
            const r2 = (radius * BUILDING_RADIUS_K) ** 2;
            this.buildings.records.forEach(rec => {
                if (rec.damage >= 2) return;
                const dx = rec.centroid.x - x, dz = rec.centroid.z - z;
                if (dx * dx + dz * dz > r2) return;
                this.stroke.buildings.push({ record: rec, previous: rec.damage || 0 });
                this.damage.setState(rec, 2);
                changed = true;
            });
        }

        if (this.scorch) {
            this.scorch.paintAt(x, z, radius, SCORCH_COLOR, 0.5);
            this.stroke.dabs++;
            changed = true;
        }
        if (changed && record) this.stroke.circles = (this.stroke.circles || 0) + 1;
        return changed;
    }

    /**
     * Close the stroke.
     * @returns {(() => void)|null} an undo closure, or null if the stroke was empty
     */
    end() {
        const stroke = this.stroke;
        this.stroke = null;
        if (!stroke || (!stroke.trees.length && !stroke.buildings.length && !stroke.dabs)) return null;
        return () => {
            this.vegetation?.setHidden(stroke.trees, false);
            // restore in reverse so a building touched twice ends on its earliest state
            [...stroke.buildings].reverse()
                .forEach(({ record, previous }) => this.damage.setState(record, previous));
            this.scorch?.undoDabs(stroke.dabs);
            this.circles.length = Math.max(0, this.circles.length - (stroke.circles || 0));
        };
    }

    // ── serialisation ──────────────────────────────────────────────────────

    serialize() { return this.circles.map(c => ({ ...c })); }

    // Replay saved circles onto a freshly loaded scene. Buildings resolve through
    // their own stable ids; trees and scorch are re-derived from the area.
    load(circles) {
        this.circles = [];
        (circles || []).forEach(c => {
            this.begin();
            this.dab(c.x, c.z, c.r, false);
            this.end();
            this.circles.push({ ...c });
        });
    }

    clear() {
        if (this.vegetation) {
            this.vegetation.setHidden([...this.vegetation.hidden.keys()], false);
        }
        this.circles.length = 0;
        this.stroke = null;
    }
}
