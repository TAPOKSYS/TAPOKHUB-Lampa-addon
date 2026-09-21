// Привести ответ TMDB к карточке, которую понимают Card/Router('full').
//
// Возвращает КОПИЮ: ответ TMDB лежит в нативном кеше запросов (IndexedDB),
// править его на месте и класть туда функции нельзя.
//
// Фон подписывается через params.emit самой карточки, а не в обработчиках
// экрана: так он одинаков везде, в том числе в рядах на главной, которые
// строит нативный main.js (он вешает свой onFocus с размытым постером).
// onlyX — приоритетные обработчики Emit: нативный onX для этого события
// не вызывается. Покрываем фокус (пульт), наведение (мышь) и касание (тач).
TH.card = function (raw, type, opts) {
    var card = {};

    for (var key in raw) if (Object.prototype.hasOwnProperty.call(raw, key)) card[key] = raw[key];

    card.media_type = card.media_type || type;
    card.source = card.source || 'tmdb';

    // Постеры и кадры этой карточки Lampa запросит через Lampa.TMDB.image: пусть идут с нашего сервера
    TH.proxy.know.item(card.media_type, card.id);
    TH.proxy.know.image(card.poster_path);
    TH.proxy.know.image(card.backdrop_path);

    // Router определяет movie/tv по original_name, у сериалов он должен быть.
    if (card.media_type == 'tv' && !card.original_name) card.original_name = card.name || '';

    var background = function () { TH.background(card); };

    // Фон меняем по фокусу (пульт, клавиатура) и по наведению мыши. По касанию НЕ меняем:
    // на телефоне тап и так открывает фильм, а смена фона в начале каждого свайпа перерисовывала
    // весь экран прямо во время прокрутки (замер: вдвое больше работы, в 6 раз больше пересчётов
    // стилей, чем у нативных рядов) и давала рывки карточек.
    var emit = {
        // Enter/тап: страница фильма или сразу торрент (настройка, см. TH.play.open); onlyEnter заменяет штатный переход Lampa
        onlyEnter: function () { TH.play.open(card); },
        // метка для стилей выделения (см. TH.css в modules/ui/line.js); html к этому моменту уже создан
        onCreate: function () {
            if (this.html && this.html.addClass) this.html.addClass('tapokhub-card');
        }
    };

    // opts.background === false: экран сам рисует фон (см. TH.backdrop), кадры фильмов ему не нужны,
    // а каждая смена фона Lampa перерисовывает canvas впустую
    if (!opts || opts.background !== false) {
        emit.onlyFocus = background;

        if (!(Lampa.Utils && Lampa.Utils.isTouchDevice && Lampa.Utils.isTouchDevice())) emit.onlyHover = background;
    }

    card.params = { emit: emit };

    return card;
};
