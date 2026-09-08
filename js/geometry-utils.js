class GeometryUtils {
    static cleanCoords(ring) {
        return ring.map(coord => [coord[0], coord[1]]);
    }

    static toLatLngRing(ring) {
        return ring.map(coord => [coord[1], coord[0]]);
    }

    static toLatLngPolygon(geometry) {
        if (!geometry) {
            return null;
        }

        if (geometry.type === 'Polygon') {
            return geometry.coordinates.map(ring => GeometryUtils.toLatLngRing(ring));
        }

        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.map(polygon => polygon.map(ring => GeometryUtils.toLatLngRing(ring)));
        }

        return null;
    }

    static toTurfPolygons(geometry) {
        if (!geometry) {
            return [];
        }

        if (geometry.type === 'Polygon') {
            const cleanCoords = geometry.coordinates.map(ring => GeometryUtils.cleanCoords(ring));
            return [turf.polygon(cleanCoords)];
        }

        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.map(polyCoords => {
                const cleanCoords = polyCoords.map(ring => GeometryUtils.cleanCoords(ring));
                return turf.polygon(cleanCoords);
            });
        }

        if (geometry.type === 'GeometryCollection') {
            const polygons = [];
            (geometry.geometries || []).forEach(child => {
                polygons.push(...GeometryUtils.toTurfPolygons(child));
            });
            return polygons;
        }

        return [];
    }
}

window.GeometryUtils = GeometryUtils;
