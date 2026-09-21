/*
 * Библиотека в Lampa: клиент API нашего сервера, две кнопки на стандартной карточке фильма
 * и минимальный экран коллекции-франшизы.
 *
 * Кнопки встают в видимый ряд .full-start-new__buttons рядом с «Закладками» (скрытый контейнер
 * .buttons--container Lampa сама группирует под кнопкой «Смотреть», нам туда не надо):
 *   «В библиотеку»       одиночная позиция, переключатель
 *   «Создать коллекцию»  сервер собирает всю франшизу (коллекция TMDB + Wikidata): части, спин-оффы,
 *                        сериалы, мультсериалы. Сборка идёт в фоне, кнопка показывает ход и результат.
 *
 * Всё хранится на нашем сервере (server/library.py), поэтому общее для всех устройств.
 */

/* ---------- клиент API ---------- */

TH.lib = (function () {
    var TIMEOUT = 20000;

    // Транспорт вынесен, чтобы его можно было подменить в тестах. done(ошибка | null, данные)
    function xhrTransport(method, url, body, done) {
        var xhr = new XMLHttpRequest();

        xhr.open(method, url, true);
        xhr.timeout = TIMEOUT;

        if (body) xhr.setRequestHeader('Content-Type', 'application/json');

        xhr.setRequestHeader('Accept-Language', TH.lang());   // язык сообщений сервера (ru или en), см. server core/i18n.py

        xhr.onload = function () {
            var data = null;

            try { data = JSON.parse(xhr.responseText); } catch (e) { /* пустой или не JSON */ }

            if (xhr.status >= 200 && xhr.status < 300) done(null, data);
            else done({ status: xhr.status, message: data && data.error }, data);
        };
        xhr.onerror = function () { done({ status: 0, message: 'network' }, null); };
        xhr.ontimeout = function () { done({ status: 0, message: 'timeout' }, null); };

        xhr.send(body ? JSON.stringify(body) : null);
    }

    var lib = {
        transport: xhrTransport,
        pollEvery: 3000,        // как часто спрашивать, собралась ли коллекция (мс); в тестах меньше

        // Библиотека работает только при известном адресе сервера (сборка с прокси).
        enabled: function () { return !!TH.proxy.base(); },

        url: function (path) { return TH.proxy.base() + '/lib/' + path; },

        request: function (method, path, body, done) {
            if (!lib.enabled()) return done({ status: 0, message: 'disabled' }, null);

            var base = TH.proxy.base();
            lib.transport(method, lib.url(path), body || null, function (err, data) {
                if (base !== TH.proxy.base()) return;
                done(err, data);
            });
        }
    };

    lib.status = function (kind, id, done) {
        lib.request('GET', 'status?kind=' + kind + '&id=' + id, null, done);
    };
    lib.addItem = function (kind, id, done) { lib.request('POST', 'items/add', { kind: kind, id: id }, done); };
    lib.removeItem = function (kind, id, done) { lib.request('POST', 'items/remove', { kind: kind, id: id }, done); };
    lib.createFranchise = function (kind, id, done) { lib.request('POST', 'franchises', { kind: kind, id: id }, done); };
    lib.choose = function (fid, wikidata, prop, done) {
        lib.request('POST', 'franchises/' + fid + '/choose', { wikidata: wikidata, prop: prop }, done);
    };
    // правка состава коллекции; ответ — коллекция целиком со скрытыми позициями
    lib.hideItem = function (fid, kind, id, hidden, done) {
        lib.request('POST', 'franchises/' + fid + '/hide', { kind: kind, id: id, hidden: hidden }, done);
    };
    // scope: 'item' (только эта позиция), 'collection' (вся коллекция TMDB), 'related' (всё связанное, ищется в фоне)
    lib.addToFranchise = function (fid, kind, id, scope, done) {
        lib.request('POST', 'franchises/' + fid + '/add', { kind: kind, id: id, scope: scope }, done);
    };
    lib.addOptions = function (fid, kind, id, done) {
        lib.request('POST', 'franchises/' + fid + '/add-options', { kind: kind, id: id }, done);
    };
    lib.deleteFranchise = function (fid, done) { lib.request('POST', 'franchises/' + fid + '/delete', {}, done); };
    lib.refreshFranchise = function (fid, done) { lib.request('POST', 'franchises/' + fid + '/refresh', {}, done); };
    lib.search = function (text, done) { lib.request('GET', 'search?query=' + encodeURIComponent(text), null, done); };
    lib.franchises = function (done) { lib.request('GET', 'franchises', null, done); };
    lib.items = function (done) { lib.request('GET', 'items', null, done); };

    // Экраны не должны ждать медленный или лежащий сервер: через mineTimeout строятся без «моего».
    lib.mineTimeout = 4000;

    function race(start, done) {
        var finished = false;
        var timer = setTimeout(function () {
            if (finished) return;

            finished = true;
            done(null);
        }, lib.mineTimeout);

        start(function (err, data) {
            if (finished) return;

            finished = true;
            clearTimeout(timer);
            done(err ? null : data);
        });
    }

    // Мои готовые коллекции: [] при любой проблеме, чтобы экран строился и без сервера.
    lib.loadCollections = function (done) {
        if (!lib.enabled()) return done([]);

        race(lib.franchises, function (data) {
            done(((data && data.franchises) || []).filter(function (f) { return f.status === 'ready' && !f.merged_into; }));
        });
    };

    lib.loadItems = function (done) {
        if (!lib.enabled()) return done([]);

        race(lib.items, function (data) { done((data && data.items) || []); });
    };

    // Сводка для главного экрана: { movies, tv, collections, viewed } или null (нет сервера).
    // «Просмотрено» считает сама Lampa по своей отметке «Просмотрено» (Lampa.Favorite): на сервере её нет.
    lib.loadStats = function (done) {
        if (!lib.enabled()) return done(null);

        race(function (cb) { lib.request('GET', 'stats', null, cb); }, function (data) {
            if (!data || typeof data.movies !== 'number') return done(null);

            var viewed = 0;

            try {
                var marks = TH.recs.viewedSet();      // по виду и номеру: фильм и сериал с одинаковым id не путаются

                ['movie', 'tv'].forEach(function (kind) {
                    ((data.ids && data.ids[kind]) || []).forEach(function (id) {
                        if (marks[kind + ':' + id]) viewed++;
                    });
                });
            } catch (e) { TH.log('stats: viewed unavailable', e && e.message); }

            done({ movies: data.movies, tv: data.tv, collections: data.collections, viewed: viewed });
        });
    };

    lib.franchise = function (fid, hidden, done) {
        lib.request('GET', 'franchises/' + fid + (hidden ? '?hidden=1' : ''), null, done);
    };

    return lib;
})();

/* ---------- кнопки на карточке фильма ---------- */

(function () {
    var POLL_MAX = 5 * 60 * 1000;

    function svg(name) {
        return (TH.icons[name] || '').replace('<svg ', '<svg fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" ');
    }

    // «1 позиция, 2 позиции, 5 позиций, 21 позиция»
    function plural(n, forms) {
        return TH.plural(n, forms);
    }

    TH.lib.plural = plural;

    function setClass(node, cls, on) {
        var parts = String(node.className || '').split(/\s+/).filter(function (c) { return c && c !== cls; });

        if (on) parts.push(cls);

        node.className = parts.join(' ');
    }

    function makeButton(cls, icon) {
        var btn = document.createElement('div');
        var label = document.createElement('span');

        btn.className = 'full-start__button selector ' + cls;
        btn.innerHTML = svg(icon);
        btn.appendChild(label);

        return { node: btn, label: label };
    }

    // Что за позиция открыта на странице. null, если это не TMDB-карточка.
    function target(e) {
        var obj = e.object || {};
        var id = Number(obj.id || (obj.card && obj.card.id));

        if (!id || id < 1) return null;

        return { kind: obj.method === 'tv' ? 'tv' : 'movie', id: id };
    }

    function attach(e) {
        if (!TH.lib.enabled()) return;

        var t = target(e);
        var container = e.body && e.body.find('.full-start-new__buttons');

        if (!t || !container || !container.length || container.find('.button--tapokhub-lib').length) return;

        var lib = makeButton('button--tapokhub-lib', 'library');
        var col = makeButton('button--tapokhub-col', 'collections');
        var libLabel = lib.label;
        var colLabel = col.label;
        var state = { loaded: false, failed: false, in_library: false, franchise: null, working: false };
        var pollTimer = null;
        var pollStart = 0;
        var dead = false;

        function attached() {
            return !dead && (!document.documentElement || !document.documentElement.contains || document.documentElement.contains(col.node));
        }

        function render() {
            setClass(lib.node, 'is-active', state.in_library);
            setClass(lib.node, 'is-busy', state.working || !state.loaded);
            libLabel.textContent = state.failed ? TH.t('Библиотека недоступна') : (state.in_library ? TH.t('В библиотеке') : TH.t('В библиотеку'));

            var f = state.franchise;
            var busy = !!f && (f.status === 'pending' || f.status === 'resolving');

            setClass(col.node, 'is-active', !!f && f.status === 'ready');
            setClass(col.node, 'is-busy', busy || !state.loaded);

            if (state.failed) colLabel.textContent = TH.t('Коллекция недоступна');
            else if (!f) colLabel.textContent = TH.t('Создать коллекцию');
            else if (busy) colLabel.textContent = TH.t('Собираю коллекцию…');
            else if (f.status === 'needs_choice') colLabel.textContent = TH.t('Выбрать франшизу');
            else if (f.status === 'error') colLabel.textContent = TH.t('Повторить сбор');
            else colLabel.textContent = TH.t('Коллекция');
        }

        function apply(data) {
            state.loaded = true;
            state.failed = false;
            state.in_library = !!(data && data.in_library);
            state.franchise = (data && data.franchise) || null;

            render();
        }

        function fail(message) {
            state.working = false;
            render();

            Lampa.Noty.show(message || TH.t('Сервер библиотеки недоступен'));
        }

        function stopPoll() {
            if (pollTimer) clearTimeout(pollTimer);

            pollTimer = null;
        }

        // Пока сервер собирает франшизу, раз в несколько секунд спрашиваем статус.
        function poll() {
            stopPoll();

            if (!attached() || Date.now() - pollStart > POLL_MAX) return;

            pollTimer = setTimeout(function () {
                TH.lib.status(t.kind, t.id, function (err, data) {
                    if (!attached()) return;

                    if (err) return poll();          // сеть моргнула, пробуем ещё

                    var before = state.franchise && state.franchise.status;

                    apply(data);

                    var f = state.franchise;

                    if (f && (f.status === 'pending' || f.status === 'resolving')) return poll();

                    if (f && f.status === 'ready' && before !== 'ready') {
                        Lampa.Noty.show(TH.t('Коллекция «') + f.title + TH.t('» готова: ') + f.counts.visible + ' ' + plural(f.counts.visible, [TH.t('позиция'), TH.t('позиции'), TH.t('позиций')]));
                    }
                    else if (f && f.status === 'needs_choice') chooseFranchise(f);
                    else if (f && f.status === 'error') Lampa.Noty.show(TH.t('Не удалось собрать коллекцию: ') + (f.error || TH.t('ошибка')));
                });
            }, TH.lib.pollEvery);
        }

        function startPoll() {
            pollStart = Date.now();
            poll();
        }

        // У позиции в Wikidata несколько франшиз: спрашиваем, какую собирать (штатное окно выбора Lampa).
        function chooseFranchise(f) {
            var prev = Lampa.Controller.enabled().name;

            Lampa.Select.show({
                title: TH.t('К какой франшизе относится?'),
                items: (f.choices || []).map(function (c) { return { title: c.title, choice: c }; }),
                onSelect: function (item) {
                    Lampa.Controller.toggle(prev);

                    TH.lib.choose(f.id, item.choice.wikidata, item.choice.prop, function (err, data) {
                        if (err) return fail(TH.t('Не удалось выбрать франшизу'));

                        apply({ in_library: state.in_library, franchise: data });
                        Lampa.Noty.show(TH.t('Собираю коллекцию…'));
                        startPoll();
                    });
                },
                onBack: function () { Lampa.Controller.toggle(prev); }
            });
        }

        function toggleLibrary() {
            if (state.working) return;

            if (state.failed) return refresh();

            state.working = true;
            render();

            (state.in_library ? TH.lib.removeItem : TH.lib.addItem)(t.kind, t.id, function (err, data) {
                state.working = false;

                if (err) return fail(err.status === 404 ? TH.t('Позиции нет в TMDB') : err.status === 429 && err.message ? err.message : TH.t('Не удалось изменить библиотеку'));

                apply(data);
                Lampa.Noty.show(state.in_library ? TH.t('Добавлено в библиотеку') : TH.t('Убрано из библиотеки'));
            });
        }

        function pressCollection() {
            var f = state.franchise;

            if (state.working) return;

            if (state.failed) return refresh();

            if (f && f.status === 'ready') return openFranchise(f);
            if (f && f.status === 'needs_choice') return chooseFranchise(f);
            if (f && (f.status === 'pending' || f.status === 'resolving')) return Lampa.Noty.show(TH.t('Коллекция ещё собирается…'));

            // нет коллекции или прошлая попытка закончилась ошибкой: (пере)создаём
            state.working = true;
            render();

            TH.lib.createFranchise(t.kind, t.id, function (err, data) {
                state.working = false;

                if (err) return fail(err.status === 429 && err.message ? err.message : TH.t('Не удалось создать коллекцию'));

                state.franchise = data;
                render();

                if (data.status === 'ready') return openFranchise(data);

                Lampa.Noty.show(TH.t('Собираю коллекцию, это займёт до минуты…'));
                startPoll();
            });
        }

        function refresh() {
            state.failed = false;
            render();

            TH.lib.status(t.kind, t.id, function (err, data) {
                if (err) {
                    state.failed = true;
                    state.loaded = true;
                    render();

                    return;
                }

                apply(data);

                var f = state.franchise;

                if (f && (f.status === 'pending' || f.status === 'resolving')) startPoll();
            });
        }

        lib.node.addEventListener('hover:enter', toggleLibrary);
        col.node.addEventListener('hover:enter', pressCollection);

        // рядом с «Закладками», как раньше делал старый плагин; нет её — в конец ряда
        var book = container.find('.button--book');

        if (book.length) book.after(lib.node);
        else container.append(lib.node);

        container.find('.button--tapokhub-lib').after(col.node);

        render();
        refresh();
    }

    TH.lib.attach = attach;

    // подписка на страницу фильма; вызывается один раз при запуске
    TH.lib.install = function () {
        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') attach(e);
        });
    };
})();
