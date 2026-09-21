/*
 * Состояние соединений для главного экрана: наш сервер, парсер и TorrServer.
 *
 * Каждое соединение: 'ok' отвечает, 'bad' не отвечает, 'off' не задано или выключено, 'wait' ещё проверяем.
 * Настройки берём у самой Lampa (адреса парсера и TorrServer лежат в её настройках), проверяем «есть ли ответ»:
 * любой ответ сервера, даже с ошибкой доступа, означает, что до него достучаться можно. Нет ответа вовсе (сеть,
 * блокировка, запрет CORS) — 'bad': Lampa в этом случае тоже не смогла бы им пользоваться.
 */

TH.status = (function () {
    var TIMEOUT = 4000;

    function field(name) {
        try { return Lampa.Storage.field(name); } catch (e) { return ''; }
    }

    function base(url) {
        return Lampa.Utils && Lampa.Utils.checkEmptyUrl ? Lampa.Utils.checkEmptyUrl(String(url).replace(/\/+$/, '')) : String(url).replace(/\/+$/, '');
    }

    // done(true | false): есть ли хоть какой-то ответ
    function ping(url, done) {
        var finished = false;
        var finish = function (alive) {
            if (finished) return;

            finished = true;
            done(alive);
        };

        try {
            var net = new Lampa.Reguest();

            net.timeout(TIMEOUT);
            net.silent(url, function () { finish(true); }, function (xhr) { finish(!!(xhr && xhr.status > 0)); }, false, { dataType: 'text' });
        } catch (e) { finish(false); }

        setTimeout(function () { finish(false); }, TIMEOUT + 1500);   // страховка: транспорт молчит
    }

    // Все адреса отвечают -> 'ok', часть -> 'ok' (Lampa объединяет ответы), никто -> 'bad'
    function anyAlive(urls, done) {
        var left = urls.length;
        var any = false;

        urls.forEach(function (u) {
            TH.status.ping(u, function (alive) {
                any = any || alive;

                if (--left === 0) done(any ? 'ok' : 'bad');
            });
        });
    }

    // Наш сервер: нет входа -> 'off'
    function server(done) {
        if (!TH.proxy.base()) return done('off');

        TH.lib.transport('GET', TH.proxy.base() + '/whoami', null, function (err) { done(err ? 'bad' : 'ok'); });
    }

    function torrUrl() {
        try { return Lampa.Torserver && Lampa.Torserver.url ? Lampa.Torserver.url() : ''; } catch (e) { return ''; }
    }

    function torserver(done) {
        var u = torrUrl();

        if (!u) return done('off');

        anyAlive([base(u) + '/echo'], done);
    }

    // Адреса парсера, которыми Lampa реально пользуется сейчас (как selectParserLinks в core/api/sources/parser.js)
    function parserUrls() {
        var type = field('parser_torrent_type') || 'jackett';
        var use = field('parser_use_link') || 'one';
        var links = [];

        if (type === 'jackett') {
            links = [[field('jackett_url'), field('jackett_key')], [field('jackett_url_two'), field('jackett_key_two')]];
        }
        else if (type === 'prowlarr') {
            links = [[field('prowlarr_url'), field('prowlarr_key')], [field('prowlarr_url_two'), field('prowlarr_key_two')]];
        }
        else if (type === 'torrserver') {
            var t = field(field('torrserver_use_link') === 'two' ? 'torrserver_url_two' : 'torrserver_url');

            return t ? [base(t) + '/echo'] : [];
        }

        if (use === 'one') links = links.slice(0, 1);
        else if (use === 'two') links = links.slice(1, 2);

        return links.filter(function (l) { return l[0]; }).map(function (l) {
            var key = encodeURIComponent(l[1] || '');

            return type === 'prowlarr' ? base(l[0]) + '/api/v1/system/status?apikey=' + key : base(l[0]) + '/api/v2.0/indexers?configured=true&apikey=' + key;
        });
    }

    function parser(done) {
        if (!field('parser_use')) return done('off');

        var urls = parserUrls();

        if (!urls.length) return done('off');

        anyAlive(urls, done);
    }

    // done({ server, parser, torrserver }), каждое значение приходит по мере готовности через part(name, state)
    function check(part, done) {
        var res = { server: 'wait', parser: 'wait', torrserver: 'wait' };
        var left = 3;
        var one = function (name) {
            return function (state) {
                res[name] = state;
                if (part) part(name, state);
                if (--left === 0 && done) done(res);
            };
        };

        server(one('server'));
        parser(one('parser'));
        torserver(one('torrserver'));
    }

    return { check: check, ping: ping, parserUrls: parserUrls, torrUrl: torrUrl, TIMEOUT: TIMEOUT };
})();
