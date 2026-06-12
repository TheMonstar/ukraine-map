// Coordinate projection + slippy-tile math for the 3D terrain viewer.
// Local ENU (meters) centered on (lat0, lng0): x = east, z = south (so Three.js north = -z).

const M_PER_DEG_LAT = 111320;

export function makeProjection(lat0, lng0) {
    const mPerDegLng = M_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);

    return {
        lat0, lng0,
        mPerDegLat: M_PER_DEG_LAT,
        mPerDegLng,

        toLocal(lat, lng) {
            return {
                x: (lng - lng0) * mPerDegLng,
                z: -(lat - lat0) * M_PER_DEG_LAT
            };
        },

        toLatLng(x, z) {
            return {
                lat: lat0 - z / M_PER_DEG_LAT,
                lng: lng0 + x / mPerDegLng
            };
        },

        // Bounding box [minLng, minLat, maxLng, maxLat] for a given half-extent in meters
        bbox(halfM) {
            const dLat = halfM / M_PER_DEG_LAT;
            const dLng = halfM / mPerDegLng;
            return [lng0 - dLng, lat0 - dLat, lng0 + dLng, lat0 + dLat];
        }
    };
}

export function latLngToTile(lat, lng, z) {
    const n = Math.pow(2, z);
    const x = Math.floor((lng + 180) / 360 * n);
    const latR = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
    return { x, y, z };
}

export function latLngToTileFraction(lat, lng, z) {
    const n = Math.pow(2, z);
    const latR = lat * Math.PI / 180;
    const fx = (lng + 180) / 360 * n;
    const fy = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
    return { fx, fy };
}

// Web Mercator normalized coordinates (0..1 across the whole world) — used for satellite UVs
export function lngToMercX(lng) {
    return (lng + 180) / 360;
}

export function latToMercY(lat) {
    const latR = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2;
}
