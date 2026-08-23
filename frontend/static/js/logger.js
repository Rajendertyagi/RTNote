/* logger.js — tiny frontend logging utility (no framework).
   Usage:
     RTWLog.debug('tree refreshed', { nodes: 42 });
     RTWLog.error('save failed', err);

   Rules:
   - Level controlled by localStorage.RTW_LOG_LEVEL ('debug'|'info'|'warn'|'error').
     Default 'warn': warnings/errors always visible, chatter silent.
   - Never log note contents, chat messages, API keys or tokens.
   - setRequestId() correlates browser logs with the backend request that
     produced them (api.js feeds it the X-Request-ID response header).
*/
(function () {
    'use strict';

    const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
    let currentRequestId = null;

    function configuredLevel() {
        try {
            const v = localStorage.getItem('RTW_LOG_LEVEL');
            if (v && LEVELS[v]) return LEVELS[v];
        } catch (e) { /* storage unavailable */ }
        return LEVELS.warn;
    }

    function fmt(args) {
        const rid = currentRequestId ? ` [${currentRequestId}]` : '';
        return `[RTW]${rid}`;
    }

    function emit(level, args) {
        if (LEVELS[level] < configuredLevel()) return;
        const prefix = fmt(args);
        /* eslint-disable no-console */
        if (level === 'error') console.error(prefix, ...args);
        else if (level === 'warn') console.warn(prefix, ...args);
        else console.log(prefix, ...args);
        /* eslint-enable no-console */
    }

    window.RTWLog = {
        debug: (...a) => emit('debug', a),
        info: (...a) => emit('info', a),
        warn: (...a) => emit('warn', a),
        error: (...a) => emit('error', a),
        setRequestId(rid) { currentRequestId = rid || null; },
    };
})();
