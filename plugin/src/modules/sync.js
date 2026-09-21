/*
 * Синхронизация настроек плагина с сервером.
 *
 * Настройки TapokHub (область помех, анимация, воспроизведение) лежат на устройстве. Чтобы они были общими для всех устройств
 * пользователя и чтобы их можно было прочитать на сервере (команда `users settings`), плагин отправляет изменения на сервер и
 * подтягивает чужие. Токен и выбранные торренты сюда не входят. Последнее слово за более поздним временем записи на сервере.
 */

TH.sync = (function () {
    var META = 'tapokhub_settings_meta';       // ключ -> время записи на сервере, которое устройство уже учло
    var applying = false;
    var timer = null;
    var PENDING = 'tapokhub_settings_pending';
    var SCOPE = 'tapokhub_settings_scope';
    var pending = Lampa.Storage.get(PENDING, {}) || {};
    var active = Lampa.Storage.get(SCOPE, '') || '';
    var busy = false;
    var epoch = 0;
    var retryDelay = 10000;
    var lastPull = 0;

    function persistPending() {
        Lampa.Storage.set(PENDING, pending, true);
    }

    function schedule(delay) {
        clearTimeout(timer);
        timer = setTimeout(flush, delay);
        if (timer && timer.unref) timer.unref();
    }

    function accountKey(scope) { return 'tapokhub_settings_account:' + encodeURIComponent(scope || 'guest'); }

    function activate(scope) {
        if (scope === active) return;
        var values = {};
        known().forEach(function (key) { values[key] = raw(key); });
        Lampa.Storage.set(accountKey(active), { values: values, meta: meta(), pending: pending }, true);
        var state = Lampa.Storage.get(accountKey(scope), null);
        clearTimeout(timer);
        timer = null;
        epoch++;
        busy = false;
        lastPull = 0;
        active = scope;
        pending = state && state.pending || {};
        applying = true;
        try {
            known().forEach(function (key) {
                var value = state && state.values ? state.values[key] : undefined;
                if (value === undefined || value === '') {
                    value = key.indexOf('tapokhub_fx_') === 0 ? TH.fx.defaults[key.slice(12)] : key.indexOf('tapokhub_play_') === 0;
                }
                Lampa.Storage.set(key, String(value), true);
            });
            saveMeta(state && state.meta || {});
            persistPending();
            Lampa.Storage.set(SCOPE, active, true);
        } finally { applying = false; }
    }

    // Какие настройки синхронизируем
    function known() {
        var keys = Object.keys(TH.fx.defaults).map(function (k) { return 'tapokhub_fx_' + k; });

        return keys.concat(['tapokhub_anim_counters', 'tapokhub_anim_crt', 'tapokhub_anim_vcr', 'tapokhub_play_auto', 'tapokhub_play_fallback', 'tapokhub_play_press', 'tapokhub_open_direct']);
    }

    function isKnown(name) {
        return known().indexOf(name) > -1;
    }

    function meta() {
        var m;

        try { m = Lampa.Storage.get(META, {}); } catch (e) { m = {}; }

        return m && typeof m === 'object' && m.length === undefined ? m : {};
    }

    function saveMeta(m) {
        try { Lampa.Storage.set(META, m, true); } catch (e) { /* не страшно */ }
    }

    function raw(key) {
        try { return Lampa.Storage.get(key, ''); } catch (e) { return ''; }
    }

    // Очередь хранится до подтверждения сервера, включая перезапуск приложения.
    function flush() {
        clearTimeout(timer);
        timer = null;
        if (busy || !Object.keys(pending).length || !TH.lib || !TH.lib.enabled()) return;
        var items = Object.assign({}, pending);
        var requestEpoch = epoch;
        busy = true;
        TH.lib.request('POST', 'settings', { settings: items }, function (err, data) {
            if (requestEpoch !== epoch) return;
            busy = false;
            if (err || !data || !data.saved) {
                schedule(retryDelay);
                retryDelay = Math.min(retryDelay * 2, 60000);
                return;
            }
            retryDelay = 10000;
            var m = meta();
            Object.keys(data.saved).forEach(function (k) {
                m[k] = data.saved[k];
                if (pending[k] === items[k]) delete pending[k];
            });
            saveMeta(m);
            persistPending();
            if (Object.keys(pending).length) schedule(2000);
        });
    }

    function push(key, value) {
        pending[key] = String(value);
        persistPending();
        schedule(2000);
    }

    // Подтянуть настройки с сервера; не чаще раза в минуту (force — сразу)
    function pull(force) {
        if (!TH.lib || !TH.lib.enabled()) return;
        if (!force && Date.now() - lastPull < 60000) return;

        lastPull = Date.now();
        var requestEpoch = epoch;

        TH.lib.request('GET', 'settings', null, function (err, data) {
            if (requestEpoch !== epoch || err || !data || !data.settings) return;

            var m = meta();
            var remote = data.settings;

            applying = true;

            try {
                known().forEach(function (key) {
                    var r = remote[key];

                    if (Object.prototype.hasOwnProperty.call(pending, key)) return;
                    // Локальные изменения отправляются только из очереди. Старые значения/дефолты
                    // не должны перезаписывать настройки сервера при входе на другом устройстве.
                    if (r && (m[key] === undefined || r.at > m[key])) {
                        Lampa.Storage.set(key, r.value, true);
                        m[key] = r.at;
                    }
                });
            } finally { applying = false; }

            saveMeta(m);

            persistPending();
            if (Object.keys(pending).length) flush();
        });
    }

    function install() {
        try {
            Lampa.Storage.listener.follow('change', function (e) {
                if (applying || !e || !isKnown(e.name)) return;

                push(e.name, e.value);
            });
        } catch (err) { TH.log('sync: storage listener unavailable', err && err.message); }

        pull(true);
    }

    return { activate: activate, install: install, pull: pull, flush: flush, known: known };
})();
