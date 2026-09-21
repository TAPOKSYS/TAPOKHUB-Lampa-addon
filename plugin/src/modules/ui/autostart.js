/* ---------- автозапуск хаба ----------
 *
 * Настройка «Запускать хаб при старте Lampa»: после запуска приложения идёт отсчёт 5 секунд, затем открывается главный
 * экран TapokHub. Любое действие в это время отменяет запуск: нажатие любой кнопки пульта или клавиатуры, касание, клик,
 * колесо мыши. Обычные кнопки при этом работают как всегда (фокус сдвинется, раздел откроется), а «Назад» дополнительно
 * гасится: иначе она ещё и вывела бы из приложения. Отсчёт также отменяется, если человек сам успел открыть другой раздел,
 * и не начинается, когда Lampa запущена по ссылке на фильм (window.start_deep_link) или хаб уже открыт.
 */
TH.autostart = (function () {
    var BACK = [8, 27, 461, 10009, 88];         // «Назад» браузера, Escape, LG, Samsung, Samsung Orsay (как в Lampa.Keypad)
    var EVENTS = ['keydown', 'mousedown', 'touchstart', 'wheel'];
    var cfg = { seconds: 5, tick: 1000, wait: 15000, poll: 250 };   // в тестах меньше
    var run = null;
    var polling = false;
    var bound = false;

    function enabled() {
        try { return !!Lampa.Storage.field('tapokhub_autostart'); } catch (e) { return false; }
    }

    function current() {
        try { return Lampa.Activity.active() || null; } catch (e) { return null; }
    }

    function where(a) {
        return a ? String(a.component) + '|' + String(a.url || '') : '';
    }

    function say(text, ms) {
        if (TH.toast) TH.toast(text, ms);
    }

    function finish() {
        if (run) clearInterval(run.timer);
        run = null;
    }

    function cancel(reason) {
        if (!run) return;

        finish();
        say(TH.t('Автозапуск TapokHub отменён'), 2500);
        TH.log('autostart: cancelled (' + reason + ')');
    }

    function tick() {
        if (!run) return;

        if (where(current()) !== run.from) {        // человек сам куда-то перешёл: не перебиваем
            finish();
            return TH.log('autostart: skipped, user navigated');
        }

        run.left -= 1;

        if (run.left <= 0) {
            finish();
            return TH.openHome();
        }

        say(TH.t('TapokHub откроется через ') + run.left + TH.t(' · любая кнопка отменяет'), cfg.tick + 600);
    }

    function begin(from) {
        run = { left: cfg.seconds, from: where(from), timer: null };
        say(TH.t('TapokHub откроется через ') + run.left + TH.t(' · любая кнопка отменяет'), cfg.tick + 600);
        run.timer = setInterval(tick, cfg.tick);
    }

    // Любое действие человека отменяет запуск. Слушаем на window в фазе перехвата, раньше Lampa: если у «Назад» отметить
    // событие как обработанное (preventDefault), Lampa его пропустит и не выйдет из приложения. Остальные кнопки не трогаем.
    function interact(e) {
        if (!run || !e) return;

        var back = e.type === 'keydown' && BACK.indexOf(e.keyCode) > -1;

        if (back && e.preventDefault) e.preventDefault();

        cancel(back ? 'back' : e.type);
    }

    function bind() {
        if (bound) return;
        bound = true;

        if (typeof window !== 'undefined' && window.addEventListener) {
            EVENTS.forEach(function (name) { window.addEventListener(name, interact, true); });
        }
    }

    // Один раз при запуске приложения. Ждёт, пока Lampa покажет стартовый экран.
    function install() {
        if (run || polling || !enabled() || (typeof window !== 'undefined' && window.start_deep_link)) return;

        bind();
        polling = true;

        var waited = 0;
        var poll = setInterval(function () {
            var a = current();

            waited += cfg.poll;

            if (!a && waited < cfg.wait) return;

            clearInterval(poll);
            polling = false;

            if (!a || a.component === TH.components.home || !enabled()) return;

            begin(a);
        }, cfg.poll);
    }

    function settings() {
        Lampa.SettingsApi.addParam({
            component: 'tapokhub',
            param: { name: 'tapokhub_autostart', type: 'trigger', default: false },
            field: { name: TH.t('Запускать хаб при старте Lampa'), description: TH.t('Через 5 секунд после запуска откроется главный экран TapokHub; любая нажатая кнопка или касание в эти секунды отменяет запуск. Настройка только для этого устройства') }
        });
    }

    return { install: install, settings: settings, cancel: cancel, config: cfg, running: function () { return !!run; } };
})();
