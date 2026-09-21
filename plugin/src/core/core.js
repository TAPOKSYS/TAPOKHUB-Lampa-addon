/*
 * TapokHub core.
 *
 * Только нативные средства Lampa 3.0.5 и новее: Lampa.Api.sources.tmdb для данных,
 * Lampa.Maker для экранов, Lampa.ContentRows / Lampa.Menu для встраивания.
 * Никакого собственного бэкенда, никаких патчей DOM и стилей.
 *
 * Ядро: объект TH, жизненный цикл, доступ к серверу и TMDB (core/), вход на устройстве, запуск (core/init.js).
 * Слои: core/ (ядро), libraries/ (самостоятельные помощники: фон, карточка, логотипы, геометрия помех),
 * modules/ (возможности: коллекции, библиотека, главный экран, воспроизведение, рекомендации, синхронизация).
 * Порядок сборки задан в plugin/build.py.
 */

var TH = {
    version: '@@VERSION@@',
    versionLabel: '@@VERSION_LABEL@@',      // как показывается в настройках: «0.9 pre-release»
    proxyBase: '@@PROXY_BASE@@', // личная сборка: адрес вместе с токеном (plugin/build.py --proxy-base); в публичной пусто
    proxyHost: '@@PROXY_HOST@@', // публичная сборка: только адрес сервера, токен устройство получает при входе (см. core/auth.js)
    assetsBase: '@@ASSETS_BASE@@',       // где лежат картинки (plugin/assets/), подставляет plugin/build.py
    assetsVersion: '@@ASSETS_VERSION@@', // хеш файлов plugin/assets/: сбрасывает кеш браузера при замене картинки
    universal: @@UNIVERSAL@@,             // общая сборка (plugin/build.py --universal): адрес сервера вводит человек в настройках, см. core/auth.js
    id: 'tapokhub',
    components: {
        home: 'tapokhub_home',               // главный экран: телевизор и XMB-меню разделов
        collections: 'tapokhub_collections', // экран со всеми коллекциями (по ряду на коллекцию)
        franchise: 'tapokhub_franchise',     // коллекция-франшиза из библиотеки (группы рядами)
        library: 'tapokhub_library',         // «Библиотека»: мои фильмы и сериалы (добавленные по одному)
        recommend: 'tapokhub_recommend'      // «Рекомендации» по просмотренному в Lampa
    },
    minimumLampa: 305   // Lampa 3.0.5: с неё есть Maker, Menu.addButton, ContentRows и то, на чём стоят экраны плагина
};

// Адрес картинки из plugin/assets/. Пусто, если сборка без адреса (тесты): тогда фон не рисуется.
TH.assetUrl = function (name) {
    var base = TH.assetsBase;
    var v = TH.assetsVersion && TH.assetsVersion.indexOf('@@') !== 0 ? '?v=' + TH.assetsVersion : '';

    // Общая сборка: картинки лежат на сервере человека (его установщик и контейнер их отдают), версия плагина сбрасывает кеш
    if (TH.universal && TH.auth && TH.auth.host()) {
        base = TH.auth.host() + '/tapokhub-assets';
        v = '?v=' + TH.version;
    }

    if (!base || base.indexOf('@@') === 0) return '';

    return base.replace(/\/+$/, '') + '/' + name + v;
};

TH.log = function () {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[TapokHub]');
    console.log.apply(console, args);
};

/* ---------- жизненный цикл ---------- */

TH.supported = function () {
    return !!(
        window.Lampa &&
        Lampa.Maker &&
        Lampa.Api && Lampa.Api.sources && Lampa.Api.sources.tmdb &&
        Lampa.Manifest && Lampa.Manifest.app_digital >= TH.minimumLampa
    );
};

// Выполнить fn, когда приложение готово (или сразу, если оно уже готово).
TH.ready = function (fn) {
    if (window.appready) fn();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type == 'ready') fn();
    });
};
