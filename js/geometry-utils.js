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
            return [GeometryUtils.toLatLngRing(geometry.coordinates[0])];
        }

        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.map(polygon => GeometryUtils.toLatLngRing(polygon[0]));
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
