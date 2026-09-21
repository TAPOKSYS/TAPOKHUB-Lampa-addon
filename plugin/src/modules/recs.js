/*
 * Рекомендации по просмотренному.
 *
 * «Просмотрено» знает только Lampa (отметки лежат на устройстве). Считаем просмотренным:
 * - позицию с отметкой «Просмотрено» (Lampa.Favorite);
 * - фильм, просмотренный на 70% и больше (такому плагин сам ставит отметку «Просмотрено», см. autoMark);
 * - сериал, у которого просмотрено (70% и больше) не меньше трёх серий.
 * Начатое и брошенное на середине не считается: по нему рекомендации не строятся, но в подборку оно тоже не попадает.
 *
 * Список просмотренного уходит на сервер (POST lib/recommend), тот спрашивает у TMDB рекомендации по каждой позиции,
 * складывает голоса и отдаёт подборку. Сервер ничего не запоминает, TMDB спрашивает с общим кешем (работает и там,
 * где TMDB заблокирован).
 */

TH.recs = (function () {
    var MOVIE_DONE = 70;     // % просмотра фильма или серии, с которого считаем «просмотрено» (и ставим отметку Lampa)
    var MIN_EPISODES = 3;    // сколько серий сериала должно быть досмотрено
    var MAX_SEASONS = 15;
    var MAX_EPISODES = 60;   // серий в сезоне проверяем не больше
    var MAX_SEEDS = 40;      // сколько последних просмотренных отдаём серверу

    function isTv(card) {
        return !!(card.original_name || card.first_air_date || card.number_of_seasons);
    }

    // Отметки «Просмотрено» с учётом вида: Lampa.Favorite.check сравнивает только id, а у фильма и сериала в TMDB
    // одинаковые номера бывают, и сериал считался бы просмотренным из-за чужого фильма (и наоборот).
    function viewedSet() {
        var set = {};

        try {
            (Lampa.Favorite.get({ type: 'viewed' }) || []).forEach(function (c) {
                if (c && c.id) set[(isTv(c) ? 'tv:' : 'movie:') + c.id] = true;
            });
        } catch (e) { TH.log('recs: viewed marks unavailable', e && e.message); }

        return set;
    }

    function percent(season, episode, name) {
        var hash = Lampa.Utils.hash([season, season > 10 ? ':' : '', episode, name].join(''));

        return (Lampa.Timeline.view(hash) || {}).percent || 0;
    }

    // Сколько серий досмотрено (считаем только до MIN_EPISODES: больше знать не нужно)
    function episodesDone(card) {
        var name = card.original_name || card.original_title;
        var seasons = Math.max(1, Math.min(Number(card.number_of_seasons) || 10, MAX_SEASONS));
        var done = 0;

        for (var s = 1; s <= seasons; s++) {
            for (var e = 1; e <= MAX_EPISODES; e++) {
                if (percent(s, e, name) >= MOVIE_DONE && ++done >= MIN_EPISODES) return done;
            }
        }

        return done;
    }

    // Просмотрена ли позиция (по правилам выше)
    function isWatched(card, marks) {
        if ((marks || viewedSet())[(isTv(card) ? 'tv:' : 'movie:') + card.id]) return true;

        if (isTv(card)) return episodesDone(card) >= MIN_EPISODES;

        return (Lampa.Timeline.view(Lampa.Utils.hash(card.original_title)) || {}).percent >= MOVIE_DONE;
    }

    /*
     * «Смотрю сейчас»: то, что начато или помечено «Смотрю» и ещё не отмечено просмотренным. Чем недавнее смотрел, тем выше.
     * Показываем сверху в «Библиотеке» (сериалы) и в «Коллекциях».
     */

    // 'вид:номер' -> место в истории Lampa (0 - смотрел последним); отметка «Смотрю» ставит выше всей истории
    function historyRank() {
        var ranks = {};
        var add = function (list, base) {
            (list || []).forEach(function (c, i) {
                var key = c && c.id ? (isTv(c) ? 'tv:' : 'movie:') + c.id : '';

                if (key && !(key in ranks)) ranks[key] = base + i / 10000;
            });
        };

        try {
            add(Lampa.Favorite.get({ type: 'look' }), -1);
            add(Lampa.Favorite.get({ type: 'history' }), 0);
        } catch (e) { TH.log('recs: history unavailable', e && e.message); }

        return ranks;
    }

    // Отдельные сериалы (карточки TMDB): те, что смотрю, от недавних к давним
    function watchingSeries(cards) {
        var ranks = historyRank();
        var marks = viewedSet();

        return (cards || []).filter(function (c) {
            return (c.media_type === 'tv' || isTv(c)) && ('tv:' + c.id) in ranks && !marks['tv:' + c.id];
        }).sort(function (a, b) { return ranks['tv:' + a.id] - ranks['tv:' + b.id]; });
    }

    // Коллекции сервера: делит на «смотрю сейчас» (что-то из состава начато, и не всё просмотрено) и остальные
    function splitCollections(list) {
        var ranks = historyRank();
        var marks = viewedSet();
        var watching = [];
        var rest = [];

        (list || []).forEach(function (f) {
            var members = f.members || [];
            var best = Infinity;
            var started = 0;
            var viewed = 0;

            members.forEach(function (m) {
                var key = m[0] + ':' + m[1];

                if (key in ranks) {
                    started++;
                    best = Math.min(best, ranks[key]);
                }

                if (marks[key]) viewed++;
            });

            if (started && viewed < members.length) watching.push({ f: f, rank: best });
            else rest.push(f);
        });

        watching.sort(function (a, b) { return a.rank - b.rank; });

        return { watching: watching.map(function (x) { return x.f; }), rest: rest };
    }

    // -> { seeds: [{kind, id, title}] от свежих к старым, exclude: [{kind, id}] всё начатое и просмотренное, movies, tv }
    function collect() {
        var cards = [];
        var seen = {};

        ['history', 'viewed'].forEach(function (type) {
            var list = [];

            try { list = Lampa.Favorite.get({ type: type }) || []; } catch (e) { TH.log('recs: favorite unavailable', e && e.message); }

            list.forEach(function (c) {
                var key = (isTv(c) ? 'tv:' : 'movie:') + c.id;

                if (c && c.id && !seen[key]) {
                    seen[key] = true;
                    cards.push(c);
                }
            });
        });

        var out = { seeds: [], exclude: [], movies: 0, tv: 0 };
        var marks = viewedSet();

        cards.forEach(function (c) {
            var kind = isTv(c) ? 'tv' : 'movie';

            out.exclude.push({ kind: kind, id: c.id });

            if (out.seeds.length < MAX_SEEDS && isWatched(c, marks)) {
                out.seeds.push({ kind: kind, id: c.id, title: c.title || c.name || '' });
                out[kind === 'tv' ? 'tv' : 'movies']++;
            }
        });

        return out;
    }

    /*
     * Автоотметка: фильм, просмотренный на 70% и больше, получает отметку «Просмотрено» (Lampa.Favorite, категория
     * viewed). Она попадает в общую сводку Lampa, убирает фильм из «Продолжить просмотр», учитывается в сводке хаба и
     * в рекомендациях. Ставится один раз на фильм: если отметку потом сняли руками, второй раз её не возвращаем.
     * Сериалы не трогаем: у них своя логика продолжения, отметку на весь сериал ставит человек.
     */
    var MARKED = 'tapokhub_automarked';

    function automarked() {
        var v = Lampa.Storage.get(MARKED, []);

        return v && v.length !== undefined ? v : [];
    }

    // -> сколько фильмов отмечено
    function autoMark() {
        var list = [];
        var done = automarked();
        var added = 0;
        var marks = viewedSet();

        try { list = Lampa.Favorite.get({ type: 'history' }) || []; } catch (e) { return 0; }

        list.forEach(function (c) {
            if (!c || !c.id || isTv(c) || !c.original_title || done.indexOf(c.id) > -1) return;

            var percent = (Lampa.Timeline.view(Lampa.Utils.hash(c.original_title)) || {}).percent || 0;

            if (percent < MOVIE_DONE) return;

            if (!marks['movie:' + c.id]) {
                Lampa.Favorite.add('viewed', c);
                added++;
            }

            done.push(c.id);   // и уже отмеченные вручную запоминаем: снятую отметку не возвращаем
        });

        if (added || done.length !== automarked().length) {
            try { Lampa.Storage.set(MARKED, done.slice(-2000)); } catch (e) { /* не страшно */ }
        }

        return added;
    }

    // Проверка при запуске и после каждого сохранения прогресса (не чаще раза в 3 секунды)
    function install() {
        var timer = null;

        function later() {
            if (timer) return;

            timer = setTimeout(function () {
                timer = null;

                try { autoMark(); } catch (e) { TH.log('automark failed', e && e.message); }
            }, 3000);
        }

        later();

        try {
            if (Lampa.Timeline && Lampa.Timeline.listener && Lampa.Timeline.listener.follow) {
                Lampa.Timeline.listener.follow('update', function (e) {
                    var road = e && e.data && e.data.road;

                    if (road && road.percent >= MOVIE_DONE) later();
                });
            }
        } catch (e) { TH.log('automark hook failed', e && e.message); }
    }

    return { historyRank: historyRank, watchingSeries: watchingSeries, splitCollections: splitCollections, isWatched: isWatched, viewedSet: viewedSet, isTv: isTv, collect: collect, autoMark: autoMark, install: install, MIN_EPISODES: MIN_EPISODES, MOVIE_DONE: MOVIE_DONE };
})();

TH.lib.recommend = function (seeds, exclude, done) {
    // подсчёт на сервере при первом запросе идёт по десятку-другому обращений к TMDB: ждём дольше обычного
    TH.lib.request('POST', 'recommend', { seeds: seeds, exclude: exclude }, done);
};

function RecommendScreen(object) {
    return GridScreen(gridParams(object, 6), function (done) {
        if (!TH.lib.enabled()) return done([]);

        var got = TH.recs.collect();

        if (!got.seeds.length) {
            Lampa.Noty.show(TH.t('Пока нечего рекомендовать: нужны досмотренные фильмы или сериалы (от ') + TH.recs.MIN_EPISODES + TH.t(' серий)'));

            return done([]);
        }

        TH.lib.recommend(got.seeds, got.exclude, function (err, data) {
            if (err || !data) {
                Lampa.Noty.show(TH.t('Не удалось получить рекомендации, попробуйте позже'));

                return done([]);
            }

            var items = data.items || [];
            var pick = function (kind) { return items.filter(function (c) { return c.media_type === kind; }); };

            done([
                { title: TH.t('Фильмы по вашим просмотрам · учтено ') + got.movies + ' ' + TH.lib.plural(got.movies, [TH.t('фильм'), TH.t('фильма'), TH.t('фильмов')]), cards: cardsOf(pick('movie'), true) },
                { title: TH.t('Сериалы по вашим просмотрам · учтено ') + got.tv + ' ' + TH.lib.plural(got.tv, [TH.t('сериал'), TH.t('сериала'), TH.t('сериалов')]), cards: cardsOf(pick('tv'), true) }
            ]);
        });
    }, { backdrop: 'blur' });
}
