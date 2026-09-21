TH.collections = (function () {
    var specs = [];
    var resolved = {}; // id -> { spec, results }

    function find(id) {
        for (var i = 0; i < specs.length; i++) if (specs[i].id === id) return specs[i];
        return null;
    }

    function add(spec) {
        if (!spec || !spec.id || !spec.title) {
            TH.log('collection needs id and title', spec);
            return false;
        }
        if (!spec.tmdb_collection && !(spec.items && spec.items.length)) {
            TH.log('collection needs tmdb_collection or items', spec.id);
            return false;
        }
        if (find(spec.id)) return false;

        specs.push(spec);

        // что считаем «своим» для нашего сервера (см. TH.proxy)
        TH.proxy.know.collection(spec.tmdb_collection);
        (spec.extras || []).concat(spec.items || []).forEach(function (i) { TH.proxy.know.item(i.type, i.id); });

        return true;
    }

    // Загрузка списка позиций {type, id}: параллельно, порядок сохраняется,
    // недоступные позиции пропускаются. done(cards)
    function fetchItems(items, done) {
        var out = new Array(items.length);
        var left = items.length;

        if (!left) return done([]);

        function finish() {
            if (--left === 0) done(out.filter(Boolean));
        }

        items.forEach(function (item, index) {
            TH.tmdb.get(item.type + '/' + item.id, function (json) {
                out[index] = TH.card(json, item.type);
                finish();
            }, finish);
        });
    }

    function byReleaseDate(a, b) {
        return String(a.release_date || a.first_air_date || '9999')
            .localeCompare(String(b.release_date || b.first_air_date || '9999'));
    }

    // Франшиза из TMDB: /collection/{id} -> parts, плюс spec.extras (спин-оффы,
    // которых нет в коллекции TMDB), без дублей, по дате выхода.
    function fromTmdbCollection(spec, done) {
        TH.tmdb.get('collection/' + spec.tmdb_collection, function (json) {
            var parts = (json.parts || []).map(function (p) {
                TH.proxy.know.item('movie', p.id); // нужно раньше карточки: за логотипом пойдём на наш сервер

                return TH.card(p, 'movie');
            });
            var have = {};

            parts.forEach(function (p) { have[p.media_type + ':' + p.id] = true; });

            var extras = (spec.extras || []).filter(function (e) { return !have[e.type + ':' + e.id]; });

            fetchItems(extras, function (added) {
                done(parts.concat(added).sort(byReleaseDate));
            });
        }, function () { done([]); });
    }

    // Подборка по списку id, порядок как задан.
    function fromItems(spec, done) {
        fetchItems(spec.items, done);
    }

    // done(collection | null); результат кешируется на время сессии.
    function resolve(id, done) {
        var spec = find(id);

        if (!spec) return done(null);
        if (resolved[id]) return done(resolved[id]);

        function complete(results) {
            if (!results.length) return done(null);

            resolved[id] = { spec: spec, results: results };
            done(resolved[id]);
        }

        if (spec.tmdb_collection) fromTmdbCollection(spec, complete);
        else fromItems(spec, complete);
    }

    // Все коллекции (или отфильтрованные) -> массив, порядок как при регистрации.
    function resolveAll(filter, done) {
        var list = specs.filter(filter || function () { return true; });
        var out = new Array(list.length);
        var left = list.length;

        if (!left) return done([]);

        list.forEach(function (spec, index) {
            resolve(spec.id, function (res) {
                out[index] = res;
                if (--left === 0) done(out.filter(Boolean));
            });
        });
    }

    return {
        add: add,
        find: find,
        list: function () { return specs.slice(); },
        resolve: resolve,
        resolveAll: resolveAll
    };
})();
