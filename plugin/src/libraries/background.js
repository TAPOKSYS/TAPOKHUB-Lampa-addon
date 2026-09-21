/* ---------- фон ----------
 *
 * Нативный Utils.cardImgBackground отдаёт кадр фильма (backdrop) только в режиме
 * фона «Изображение»; в режиме по умолчанию («Простой») это размытый постер.
 * Нам нужен именно кадр, поэтому берём backdrop_path сами, а если его нет,
 * возвращаемся к нативной логике. Настройку «Фон» (вкл/выкл) не обходим:
 * Background.change сам её проверяет и повтор того же URL игнорирует.
 */
TH.background = function (card) {
    var url = card && card.backdrop_path
        ? Lampa.Api.img(card.backdrop_path, 'w1280')
        : Lampa.Utils.cardImgBackground(card || {});

    Lampa.Background.change(url);
};

// Сброс фона к состоянию по умолчанию (цвет темы, без кадра фильма).
// В Background нет публичного «сбросить»: его canvas хранят последний кадр, а повтор того же URL он игнорирует,
// поэтому после очистки подсовываем однотонный пиксель цвета фона Lampa (#1d1f20; прозрачный давал ядовито-синюю заливку). Это меняет запомненный адрес, и тот же фильм при
// следующем фокусе рисуется снова. Пока идёт фокус (таймер change), сброс не мешает: новый URL его отменяет.
var CLEAR_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR42mOUlVdgYGBgYmBgYGBgAAAEdwBg4hAligAAAABJRU5ErkJggg==';

TH.background.reset = function () {
    try {
        var canvases = document.querySelectorAll ? document.querySelectorAll('.background canvas') : [];

        for (var i = 0; i < canvases.length; i++) {
            var c = canvases[i];
            var ctx = c.getContext && c.getContext('2d');

            if (ctx) ctx.clearRect(0, 0, c.width, c.height);
            if (c.classList) c.classList.remove('visible');
        }
    } catch (e) { TH.log('background reset failed', e && e.message); }

    Lampa.Background.change(CLEAR_PIXEL);
};
