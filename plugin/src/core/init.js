TH.init = function () {
    Lampa.Lang.add({
        tapokhub_collections: { ru: 'Коллекции', en: 'Collections', uk: 'Колекції' }
    });

    // Наш кеширующий сервер (адрес с токеном подставляет plugin/build.py; без него подмены не включаются)
    TH.auth.init();          // токен устройства -> подмены TMDB и библиотека; нет токена — вход по аккаунту CUB

    TH.css();
    TH.homeCss();

    Lampa.Component.add(TH.components.home, HomeScreen);
    Lampa.Component.add(TH.components.collections, CollectionsScreen);
    Lampa.Component.add(TH.components.franchise, FranchiseScreen);
    Lampa.Component.add(TH.components.library, LibraryScreen);
    Lampa.Component.add(TH.components.recommend, RecommendScreen);

    TH.lib.install();   // кнопки библиотеки на карточке фильма
    TH.auth.settings(); // Настройки -> TapokHub: вход, токен, выход
    TH.animSettings();  // ...и переключатели анимации главного экрана
    TH.fxSettings();    // ...и точная настройка области помех
    TH.play.settings(); // ...и воспроизведение (автозапуск выбранного торрента)
    TH.telegram.settings(); // ...и Telegram-бот (токен и чат)
    TH.play.install();  // автозапуск торрента, выбранного ранее
    TH.sync.install();  // настройки плагина: общие для устройств пользователя и видны на сервере
    TH.recs.install();  // фильм, просмотренный на 70%+, получает отметку «Просмотрено»

    addSections();

    addMenu();

    TH.autostart.install(); // по желанию: через 5 секунд после запуска открыть хаб (Назад отменяет)

    TH.log('initialized v' + TH.version);
};
