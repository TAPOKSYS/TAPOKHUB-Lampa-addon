/* ---------- логотипы ----------
 *
 * Название коллекции показываем логотипом фильма из TMDB (/images), как заголовок
 * на карточке фильма в Lampa. У коллекции TMDB своих логотипов нет, поэтому берём
 * логотип первого фильма, у которого он есть (или spec.logo_from = {type, id}).
 * Выбор по языку повторяет нативный selectLogo: язык интерфейса -> en -> без языка -> любой.
 */
TH.logos = (function () {
    var LIFE = 60 * 24 * 7;  // логотипы почти не меняются: неделя нативного кеша
    var TRIES = 5;           // сколько фильмов коллекции пробуем
    var memo = {};           // key -> url | '' (нет логотипа); сбои сети не запоминаем

    function language() {
        return String((Lampa.Storage && Lampa.Storage.field('tmdb_lang')) || 'en').split(/[-_]/)[0].toLowerCase();
    }

    function pick(logos) {
        if (!logos || !logos.length) return null;

        var order = [language(), 'en', null].filter(function (c, i, all) { return all.indexOf(c) === i; });

        for (var i = 0; i < order.length; i++) {
            var code = order[i];

            for (var j = 0; j < logos.length; j++) {
                var l = logos[j];
                var lang = String(l.iso_639_1 || '').toLowerCase();

                if (l.file_path && (code === null ? !lang : lang === code)) return l;
            }
        }

        for (var k = 0; k < logos.length; k++) if (logos[k].file_path) return logos[k];

        return null;
    }

    // done(url | '')
    function forItem(type, id, done) {
        var key = type + ':' + id;

        if (memo.hasOwnProperty(key)) return done(memo[key]);

        var langs = [language(), 'en', 'null'].filter(function (c, i, all) { return all.indexOf(c) === i; });

        TH.tmdb.get(type + '/' + id + '/images?include_image_language=' + langs.join(','), function (json) {
            var logo = pick(json && json.logos);

            if (logo) TH.proxy.know.image(logo.file_path); // до Api.img: адрес строится подменой TMDB.image

            memo[key] = logo ? Lampa.Api.img(logo.file_path, 'w500') : '';
            done(memo[key]);
        }, function () { done(''); }, LIFE);
    }

    // done(url | ''): первый найденный логотип среди кандидатов
    function forCollection(collection, done) {
        var spec = collection.spec;
        var candidates = [];
        var seen = {};

        function push(type, id) {
            var key = type + ':' + id;

            if (id && type && !seen[key] && candidates.length < TRIES + 1) {
                seen[key] = true;
                candidates.push({ type: type, id: id });
            }
        }

        if (spec.logo_from) push(spec.logo_from.type, spec.logo_from.id);

        collection.results.forEach(function (card) { push(card.media_type, card.id); });

        (function next(i) {
            if (i >= candidates.length) return done('');

            forItem(candidates[i].type, candidates[i].id, function (url) {
                if (url) done(url);
                else next(i + 1);
            });
        })(0);
    }

    // Заменить название ряда картинкой. Пока логотип грузится (или его нет),
    // остаётся обычный текст. line — экземпляр Line, this в onCreate.
    function applyToLine(line, collection) {
        var html = line && line.html;
        if (!html || !html.querySelector) return;

        var target = html.querySelector('.items-line__title');
        if (!target) return;

        forCollection(collection, function (url) {
            if (!url || !target.parentNode) return; // логотипа нет или ряд уже убрали

            var img = new Image();

            img.className = 'tapokhub-logo';
            img.alt = collection.spec.title;
            img.onload = function () {
                target.innerHTML = '';
                target.appendChild(img);
            };
            img.src = url;
        });
    }

    // Заменить текст в элементе картинкой по пути TMDB (логотип, найденный сервером).
    // target: DOM-элемент или jQuery (берём первый). Пока картинка не загрузилась, остаётся текст.
    function replaceText(target, path, alt) {
        var el = target && (target.jquery ? target[0] : target);

        if (!el || !path) return;

        TH.proxy.know.image(path);

        var img = new Image();

        img.className = 'tapokhub-logo';
        img.alt = alt || '';
        img.onload = function () {
            if (!el.parentNode) return;    // карточку уже убрали

            el.innerHTML = '';
            el.appendChild(img);
        };
        img.src = Lampa.Api.img(path, 'w500');
    }

    return { pick: pick, forItem: forItem, forCollection: forCollection, applyToLine: applyToLine, replaceText: replaceText };
})();

/* ---------- реестр коллекций ----------
 *
 * Описание коллекции (spec):
 *   { id, title, home, tmdb_collection: <id>,
 *     extras: [{type, id}] }                           франшиза целиком из TMDB (+ спин-оффы)
 *   { id, title, home, items: [{type, id}, ...] }     произвольная подборка
 *   home: true — показывать ряд на главном экране Lampa.
 *   logo_from: {type, id} — чей логотип показывать вместо названия (иначе первый найденный).
 */
