/**
 * DataStore - Simplified for public version
 * Private data sources (Google Sheets) removed
 */
class DataStore {
    constructor(dashboard) {
        this.dashboard = dashboard;
    }

    normalizeDirectionData(data) {
        return data.map(item => ({
            ...item,
            _date: item._date || new Date(item.Date)
        }));
    }

    normalizeLocationData(data) {
        return data.map(item => ({
            ...item,
            _date: item._date || new Date(item.date),
            _lat: item._lat ?? parseFloat(item.Lat),
            _lon: item._lon ?? parseFloat(item.Lon)
        }));
    }

    async handleSourceChange() {
        // No-op in public version (data sources removed)
    }

    combineSourceData() {
        // No-op in public version
    }

    async loadAllData() {
        // No-op in public version
    }
}

window.DataStore = DataStore;
