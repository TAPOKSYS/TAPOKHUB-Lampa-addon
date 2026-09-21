/* ---------- наш кеширующий сервер (TMDB заблокирован из России) ----------
 *
 * Lampa 3.x сама подменяет Lampa.TMDB.api / Lampa.TMDB.image своими зеркалами (core/tmdb/proxy.js),
 * а ручной прокси убрала из настроек. Штатный плагин tmdb_proxy делает то же самое подменой этих
 * двух функций, поэтому делаем так и мы, но ТОЛЬКО для того, что относится к нашим коллекциям:
 * их фильмов, логотипов, постеров и кадров. Остальной трафик Lampa идёт как раньше.
 *
 * Наш сервер (server/tapokhub/modules/proxy.py) хранит ответы TMDB в SQLite, картинки на диске, и
 * отдаёт последнюю копию, если TMDB недоступен. Ключ TMDB берёт у самой Lampa.
 *
 * Если сервер не отвечает, запрос повторяется штатным путём Lampa, и до восстановления
 * (5 минут) наши подмены отключены. Без адреса сервера (сборка без прокси) всё это не работает.
 */
TH.proxy = (function () {
    var DOWN_FOR = 5 * 60 * 1000;
    var base = '';
    var downAt = 0;
    var installed = false;
    var origApi = null;
    var origImage = null;
    var known = { collections: {}, items: {}, images: {} };

    function enabled() {
        return !!base && (!downAt || Date.now() - downAt > DOWN_FOR);
    }

    // Наш ли это запрос к API: только коллекции и фильмы, которые мы сами знаем.
    function mineApi(path) {
        var m = /^collection\/(\d+)$/.exec(path);

        if (m) return !!known.collections[m[1]];

        m = /^(movie|tv)\/(\d+)(\/images)?$/.exec(path);

        return !!(m && known.items[m[1] + ':' + m[2]]);
    }

    function install() {
        if (installed || !window.Lampa || !Lampa.TMDB) return;

        installed = true;
        origApi = Lampa.TMDB.api;
        origImage = Lampa.TMDB.image;

        Lampa.TMDB.api = function (url) {
            var path = String(url).split('?')[0];

            if (enabled() && mineApi(path)) return base + '/api/https://api.themoviedb.org/3/' + url;

            return origApi.apply(this, arguments);
        };

        Lampa.TMDB.image = function (url) {
            var m = /^t\/p\/([^/]+)\/+([^/?]+)/.exec(String(url));

            if (enabled() && m && known.images[m[2]]) return base + '/img/https://image.tmdb.org/t/p/' + m[1] + '/' + m[2];

            return origImage.apply(this, arguments);
        };
    }

    // Адрес сервера вместе с токеном: https://хост/tmdb/<токен>. Пустой = выключено.
    function configure(url) {
        var next = String(url || '').replace(/\/+$/, '');
        if (next !== base) {
            if (TH.sync) TH.sync.activate(next);
            if (TH.play) TH.play.reset();
        }
        base = next;
        downAt = 0;

        if (base) {
            install();
            check(function () {});
        }
    }

    // Жив ли сервер. При недоступности включается режим «штатный путь» на DOWN_FOR.
    function check(done) {
        if (!base) return done(false);

        var net = new Lampa.Reguest();

        net.timeout(4000);
        net.silent(base + '/health', function (json) {
            var alive = !!(json && json.ok);

            downAt = alive ? 0 : Date.now();
            done(alive);
        }, function () {
            downAt = Date.now();
            done(false);
        });
    }

    return {
        configure: configure,
        enabled: enabled,
        uses: function (path) { return enabled() && mineApi(String(path).split('?')[0]); },
        check: check,
        base: function () { return base; },
        know: {
            collection: function (id) { if (id) known.collections[id] = true; },
            item: function (type, id) { if (type && id) known.items[type + ':' + id] = true; },
            image: function (path) { if (path) known.images[String(path).replace(/^\/+/, '')] = true; }
        }
    };
})();
