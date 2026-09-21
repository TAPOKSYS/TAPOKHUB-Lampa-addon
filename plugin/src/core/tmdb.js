/* ---------- TMDB ---------- */

TH.tmdb = {
    // Сутки, в минутах: срок жизни кеша запросов (кеш нативный, IndexedDB).
    cacheLife: 60 * 24,

    // life — срок жизни кеша в минутах (по умолчанию сутки).
    // Запрос к «нашему» ресурсу идёт через наш сервер (подмена Lampa.TMDB.api, см. TH.proxy).
    // Если он не ответил: 404 бывает и у нас, поэтому сначала проверяем, жив ли сервер, и только
    // если нет, повторяем штатным путём Lampa.
    get: function (path, ok, fail, life) {
        var api = Lampa.Api.sources.tmdb;
        var cache = { life: life || TH.tmdb.cacheLife };
        var viaOurs = TH.proxy.uses(path);

        api.get(path, {}, ok, function () {
            if (!viaOurs) return fail && fail();

            TH.proxy.check(function (alive) {
                if (alive) return fail && fail();

                api.get(path, {}, ok, fail, cache); // сервер лежит: подмены уже выключены
            });
        }, cache);
    }
};
