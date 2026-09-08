/** Keep feed/imported strings out of executable HTML and URL contexts. */
class HtmlUtils {
    static escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
    }

    static link(value, label = 'Source') {
        try {
            const url = new URL(value);
            if (!['https:', 'http:'].includes(url.protocol)) return '';
            return `<a href="${this.escape(url.href)}" target="_blank" rel="noopener noreferrer">${this.escape(label)}</a>`;
        } catch (_) {
            return '';
        }
    }
}
