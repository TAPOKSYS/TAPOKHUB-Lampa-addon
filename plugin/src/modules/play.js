/*
 * Автозапуск выбранного ранее торрента.
 *
 * Когда для фильма или сериала торрент уже выбирали, кнопка «Торренты» на карточке не открывает список парсера, а сразу
 * запускает тот же торрент: TorrServer добавляет его и отдаёт список файлов, Lampa показывает файлы и запускает нужный
 * (для сериала следующий по просмотру, для фильма единственный файл). Если торрент не отвечает (нет раздающих, TorrServer не
 * получил список файлов за ~25 секунд), плагин открывает обычный поиск по парсеру, чтобы выбрать другой.
 * «Назад» на экране запуска тоже открывает список парсера. Выбранные торренты запоминаются на устройстве (Storage) и на сервере
 * (для каждого пользователя свои, общие на всех его устройствах): на новом устройстве они подтягиваются при входе.
 *
 * Ещё одна настройка («Открывать фильм сразу через торрент»): Enter на карточке в хабе не открывает страницу фильма, а
 * сразу «Торренты»: выбранный ранее торрент запускается, если торрент не выбирали, открывается парсер (см. open).
 *
 * Настройки: Настройки -> TapokHub -> Воспроизведение.
 */

TH.play = (function () {
    var KEY = 'tapokhub_torrents';
    var revision = 0;
    var cacheVersion = 0;

    function storageKey() {
        // Токены разных аккаунтов/серверов никогда не делят один кеш.
        // Старый общий кеш остаётся на диске, но не загружается в чужой аккаунт.
        return KEY + ':' + encodeURIComponent(TH.proxy.base() || 'guest');
    }

    function reset() {
        revision++;
        lastSync = 0;
        armed = null;
        running = null;
        entries = [];
    }
    var LIMIT = 300;                // сколько выбранных торрентов помним
    var timing = { wait: 25000, every: 2000, press: 700 };   // мс: сколько ждём список файлов, как часто спрашиваем, когда нажимаем файл (в тестах короче)
    var running = null;             // ключ фильма, торрент которого сейчас запускается (повторный Enter не запускает второй раз)
    var armed = null;               // запуск, для которого ждём список файлов (нажать нужный файл сами)
    var entries = [];               // элементы списка файлов, которые показала Lampa

    function field(name) {
        try { return Lampa.Storage.field(name); } catch (e) { return false; }
    }

    function tv(movie) {
        return !!(movie.original_name || movie.first_air_date || movie.number_of_seasons);
    }

    function keyOf(movie) {
        return (tv(movie) ? 'tv:' : 'movie:') + movie.id;
    }

    function load() {
        var v;

        try { v = Lampa.Storage.get(storageKey(), {}); } catch (e) { v = {}; }

        return v && typeof v === 'object' && v.length === undefined ? v : {};
    }

    function save(map) {
        cacheVersion++;
        var keys = Object.keys(map);

        if (keys.length > LIMIT) {
            keys.sort(function (a, b) { return (map[a].at || 0) - (map[b].at || 0); });
            keys.slice(0, keys.length - LIMIT).forEach(function (k) { delete map[k]; });
        }

        try { Lampa.Storage.set(storageKey(), map); } catch (e) { TH.log('play: not saved', e && e.message); }
    }

    // Запомнить выбранный торрент (вызывается при каждом запуске торрента из Lampa)
    function remember(element, movie) {
        if (!element || !movie || !movie.id || !(element.MagnetUri || element.Link)) return;

        revision++;
        var map = load();

        map[keyOf(movie)] = {
            title: element.title || element.Title || '',
            MagnetUri: element.MagnetUri || '',
            Link: element.Link || '',
            poster: element.poster || '',
            tracker: element.tracker || element.Tracker || '',
            at: Date.now(),
            dirty: true
        };

        save(map);

        upload(keyOf(movie), map[keyOf(movie)]);
    }

    function upload(key, rec) {
        if (!TH.lib || !TH.lib.enabled()) return;
        var account = storageKey();
        var rev = revision;
        var parts = key.split(':');
        TH.lib.request('POST', 'torrents', { kind: parts[0], id: Number(parts[1]), title: rec.title, MagnetUri: rec.MagnetUri, Link: rec.Link, poster: rec.poster, tracker: rec.tracker }, function (err, data) {
            if (err || !data || !data.at || account !== storageKey() || rev !== revision) return;
            var map = load();
            // Ответ старого запроса не подтверждает более поздний выбор.
            if (map[key] && map[key].at === rec.at && map[key].MagnetUri === rec.MagnetUri && map[key].Link === rec.Link) {
                map[key].at = data.at;
                map[key].dirty = false;
                save(map);
            }
        });
    }

    var lastSync = 0;

    // Сервер — источник уже подтверждённых записей. Отправляем только новые локальные изменения.
    function sync(force) {
        if (!TH.lib || !TH.lib.enabled()) return;
        if (!force && Date.now() - lastSync < 60000) return;
        lastSync = Date.now();
        var account = storageKey();
        var rev = revision;
        var version = cacheVersion;

        TH.lib.request('GET', 'torrents', null, function (err, data) {
            if (err || !data || !data.items || account !== storageKey() || rev !== revision || version !== cacheVersion) return;
            var map = load();
            var remote = {};
            data.items.forEach(function (x) {
                var key = x.kind + ':' + x.id;
                remote[key] = x;
                if (!map[key] || !map[key].dirty) {
                    map[key] = { title: x.title || '', MagnetUri: x.MagnetUri || '', Link: x.Link || '', poster: x.poster || '', tracker: x.tracker || '', at: x.at, dirty: false };
                }
            });
            Object.keys(map).forEach(function (key) {
                if (!remote[key] && !map[key].dirty) delete map[key];
            });
            save(map);
            Object.keys(map).forEach(function (key) {
                if (map[key].dirty) upload(key, map[key]);
            });
        });
    }

    function saved(movie) {
        return movie && movie.id ? load()[keyOf(movie)] || null : null;
    }

    function forget(done) {
        var n = Object.keys(load()).length;
        var account = storageKey();
        var rev = ++revision;       // старые GET/POST не должны воскресить очищенный кеш
        function finish(err) {
            if (account !== storageKey() || rev !== revision) return;
            if (!err) save({});
            if (done) done(err, n);
        }
        if (TH.lib && TH.lib.enabled()) TH.lib.request('POST', 'torrents/forget', { all: true }, finish);
        else finish(null);
        return n;
    }

    // Сообщения о запуске показываем сверху (внизу их перекрывала бы панель Lampa), см. TH.toast
    function noty(text) {
        TH.toast(text);
    }

    function androidClient() {
        try { return Lampa.Platform.is('android') && !field('internal_torrclient'); } catch (e) { return false; }
    }

    // Сам запуск. object — параметры экрана «Торренты» (в них фильм), push — настоящий Activity.push.
    function run(object, rec, push) {
        var movie = object.movie;

        if (running === keyOf(movie)) return;   // этот запуск уже идёт: второе нажатие ничего не делает

        running = keyOf(movie);

        var finished = false;
        var timer = null;
        var started = Date.now();
        var element = { title: rec.title, MagnetUri: rec.MagnetUri, Link: rec.Link, poster: rec.poster, Tracker: rec.tracker };

        function end() {
            finished = true;
            running = null;
            clearTimeout(timer);

            try { Lampa.Loading.stop(); } catch (e) { /* уже закрыт */ }
        }

        // Открыть обычный список парсера: выбрать другой торрент
        function other(text) {
            if (finished) return;

            end();
            armed = null;

            if (text) noty(text);

            push.call(Lampa.Activity, Object.assign({}, object, { tapokhub_skip: true }));
        }

        function unavailable(hash) {
            if (finished) return;

            try { if (hash) Lampa.Torserver.drop(hash); } catch (e) { /* не страшно */ }

            if (field('tapokhub_play_fallback')) other(TH.t('TapokHub: выбранный торрент недоступен, ищу другие через парсер'));
            else {
                end();
                noty(TH.t('TapokHub: выбранный торрент недоступен'));
            }
        }

        function poll(hash) {
            if (finished) return;

            Lampa.Torserver.files(hash, function (json) {
                if (finished) return;

                if (json && json.file_stats && json.file_stats.length) {
                    end();

                    armed = field('tapokhub_play_press') ? { movie: movie } : null;
                    entries = [];
                    Lampa.Torrent.open(hash, movie);   // дальше Lampa сама: список файлов, автозапуск единственного файла
                }
            }, function () { /* повторим на следующем шаге */ });

            timer = setTimeout(function () {
                if (finished) return;

                if (Date.now() - started > timing.wait) unavailable(hash);
                else poll(hash);
            }, timing.every);
        }

        // Андроид-клиент сам управляет торрентами: проверить заранее нечем
        if (androidClient()) {
            noty(TH.t('TapokHub: запускаю выбранный ранее торрент'));
            running = null;     // ожидания нет: клиент Android дальше управляет сам
            Lampa.Torrent.start(element, movie);

            return;
        }

        // Сообщение одно, на экране ожидания: тост с тем же текстом рядом дублировал бы его
        Lampa.Loading.start(function () { other(''); }, TH.t('TapokHub: запускаю выбранный ранее торрент (Назад: выбрать другой)'));

        Lampa.Torserver.connected(function () {
            if (finished) return;

            Lampa.Torserver.hash({ title: element.title, link: rec.MagnetUri || rec.Link, poster: rec.poster, data: { lampa: true, movie: movie } }, function (json) {
                if (finished) return;

                if (json && json.hash) poll(json.hash);
                else unavailable('');
            }, function () { unavailable(''); });
        }, function () {
            // TorrServer не отвечает: дело не в торренте, показываем штатную ошибку Lampa
            if (finished) return;

            end();
            Lampa.Torrent.start(element, movie);
        });
    }

    // Нужно ли перехватить открытие экрана «Торренты»
    function intercept(object) {
        return !!(object && object.component === 'torrents' && object.movie && object.movie.id && !object.tapokhub_skip &&
            (field('tapokhub_play_auto') || object.tapokhub_direct) && saved(object.movie) && Lampa.Torserver && (androidClient() || Lampa.Torserver.url()));
    }

    // Поисковый запрос парсера по настройке Lampa «Язык поиска»: те же комбинации, что у кнопки «Торренты» на карточке
    function query(movie) {
        var title = movie.title || movie.name || '';
        var original = movie.original_title || movie.original_name || '';
        var year = ((movie.first_air_date || movie.release_date || '0000') + '').slice(0, 4);
        var combinations = {
            df: original, df_year: original + ' ' + year, df_lg: original + ' ' + title, df_lg_year: original + ' ' + title + ' ' + year,
            lg: title, lg_year: title + ' ' + year, lg_df: title + ' ' + original, lg_df_year: title + ' ' + original + ' ' + year
        };

        return { one: title, two: original, text: combinations[field('parse_lang')] || combinations.df };
    }

    function directOn(card) {
        var torrents = !window.lampa_settings || window.lampa_settings.torrents_use !== false;

        return !!(card && card.id && field('tapokhub_open_direct') && field('parser_use') && torrents);
    }

    // Enter на карточке в хабе. Обычно открывается страница фильма; с настройкой «Открывать фильм сразу через торрент» —
    // сразу «Торренты»: Activity.push (наш перехват выше) запускает выбранный торрент, а без выбора остаётся парсер.
    function open(card) {
        if (!directOn(card)) return Lampa.Router.call('full', card);

        var q = query(card);
        var movie = Object.assign({}, card, { title: q.one, original_title: q.two });

        Lampa.Activity.push({
            url: '',
            title: Lampa.Lang.translate('title_torrents'),
            component: 'torrents',
            search: q.text,
            search_one: q.one,
            search_two: q.two,
            movie: movie,
            page: 1,
            tapokhub_direct: true
        });
    }

    // После того как Lampa показала список файлов, нажать нужный: тот, что смотрели последним, или следующий, если он досмотрен
    function press() {
        var list = entries;

        entries = [];

        if (!armed || !list.length) return;

        armed = null;

        var last = -1;

        list.forEach(function (e, i) { if (e.element.timeline && e.element.timeline.percent > 0) last = i; });

        var index = 0;

        if (last > -1) {
            var pct = list[last].element.timeline.percent;

            if (pct >= 90) {
                if (!list[last + 1]) return;      // досмотрено всё: сами ничего не запускаем, список открыт на последней серии

                index = last + 1;
            }
            else index = last;
        }

        try { list[index].item.trigger('hover:enter'); } catch (e) { TH.log('play: press failed', e && e.message); }
    }

    function install() {
        sync(true);   // при запуске: подтянуть выбор с других устройств

        if (!window.Lampa || !Lampa.Activity || !Lampa.Torrent || Lampa.Torrent.__tapokhub) return;

        Lampa.Torrent.__tapokhub = true;

        var start = Lampa.Torrent.start;

        Lampa.Torrent.start = function (element, movie) {
            try { remember(element, movie); } catch (e) { TH.log('play: remember failed', e && e.message); }

            return start.apply(this, arguments);
        };

        var push = Lampa.Activity.push;

        Lampa.Activity.push = function (object) {
            if (intercept(object)) {
                try {
                    run(object, saved(object.movie), push);

                    return;
                } catch (e) { running = null; TH.log('play: auto start failed', e && e.message); }
            }

            return push.apply(this, arguments);
        };

        if (Lampa.Listener && Lampa.Listener.follow) {
            Lampa.Listener.follow('torrent_file', function (e) {
                if (!armed) return;

                if (e.type === 'list_open') entries = [];
                else if (e.type === 'render') entries.push({ element: e.element, item: e.item });
                else if (e.type === 'list_close') { armed = null; entries = []; }

                if (e.type === 'list_open') setTimeout(press, timing.press);   // Lampa успеет показать список
            });
        }
    }

    // Параметры в разделе «Воспроизведение» настроек
    function settings() {
        if (!window.Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addParam || !TH.settingsPage) return;

        TH.settingsPage('tapokhub_play', TH.t('Воспроизведение'));

        TH.settingsTitle('tapokhub_play', TH.t('Запуск выбранного торрента'));

        Lampa.SettingsApi.addParam({
            component: 'tapokhub_play',
            param: { name: 'tapokhub_play_auto', type: 'trigger', default: true },
            field: { name: TH.t('Запускать выбранный ранее торрент'), description: TH.t('Кнопка «Торренты» на карточке сразу запускает торрент, который вы уже выбирали для этого фильма или сериала, без списка парсера') }
        });

        Lampa.SettingsApi.addParam({
            component: 'tapokhub_play',
            param: { name: 'tapokhub_open_direct', type: 'trigger', default: false },
            field: { name: TH.t('Открывать фильм сразу через торрент'), description: TH.t('Enter на карточке в TapokHub не открывает страницу фильма: если торрент уже выбран, он запускается, если нет, открывается поиск по парсеру') }
        });

        Lampa.SettingsApi.addParam({
            component: 'tapokhub_play',
            param: { name: 'tapokhub_play_fallback', type: 'trigger', default: true },
            field: { name: TH.t('Искать другие, если недоступен'), description: TH.t('Если торрент не отвечает (нет раздающих или TorrServer не получил файлы за 25 секунд), откроется поиск по парсеру') }
        });

        Lampa.SettingsApi.addParam({
            component: 'tapokhub_play',
            param: { name: 'tapokhub_play_press', type: 'trigger', default: true },
            field: { name: TH.t('Сразу запускать файл или серию'), description: TH.t('Для сериала запускается серия, на которой остановились, или следующая; иначе нужно нажать OK в списке файлов') }
        });

        TH.settingsTitle('tapokhub_play', TH.t('Сохранённый выбор'));

        Lampa.SettingsApi.addParam({
            component: 'tapokhub_play',
            param: { name: 'tapokhub_play_forget', type: 'button' },
            field: { name: TH.t('Забыть выбранные торренты'), description: TH.t('После этого «Торренты» снова открывают список парсера') },
            onChange: function () {
                forget(function (err, n) {
                    noty(err ? TH.t('TapokHub: не удалось очистить торренты, повторите позже') : TH.t('TapokHub: забыто выбранных торрентов: ') + n);
                });
            }
        });
    }

    return { storageKey: storageKey, reset: reset, install: install, settings: settings, sync: sync, remember: remember, saved: saved, forget: forget, intercept: intercept, open: open, run: run, press: press, keyOf: keyOf, timing: timing };
})();
