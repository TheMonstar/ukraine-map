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
        const gsuaChecked = this.dashboard.isChecked('source-gsua');
        const directionChecked = this.dashboard.isChecked('source-gsua-direction');

        if (gsuaChecked && this.dashboard.sourceData.gsua.location.length === 0) {
            this.dashboard.sourceData.gsua.location = this.normalizeLocationData(
                await this.loadSourceData('engagements')
            );
        }
        if (directionChecked && this.dashboard.sourceData.gsua.direction.length === 0) {
            this.dashboard.sourceData.gsua.direction = this.normalizeDirectionData(
                await this.loadSourceData('morning')
            );
        }

        this.combineSourceData();
    }

    async loadSourceData(source) {
        try {
            const response = await fetch(`https://flask-app-kibakefmpq-ew.a.run.app/sheets/${source}/data`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const result = await response.json();
            return result.data;
        } catch (error) {
            console.error(`Error loading ${source} data:`, error);
            return [];
        }
    }

    combineSourceData() {
        const gsuaChecked = this.dashboard.isChecked('source-gsua');
        const directionChecked = this.dashboard.isChecked('source-gsua-direction');

        this.dashboard.locationData = [];
        this.dashboard.directionData = [];

        if (gsuaChecked) {
            this.dashboard.locationData.push(
                ...this.dashboard.sourceData.gsua.location.map(item => ({ ...item, source: 'gsua' }))
            );
        }
        if (directionChecked) {
            this.dashboard.directionData.push(...this.dashboard.sourceData.gsua.direction);
        }

        this.dashboard.updateMap();
    }

    async loadAllData() {
        // No-op in public version
    }
}

window.DataStore = DataStore;
