/*
 * TapokHub UI: нативные экраны на Lampa.Maker и встраивание в приложение.
 *
 * Структура повторяет components/main.js из исходников Lampa 3.x:
 * Main -> Line -> Card, обработчики через .use().
 *
 * Экраны «Коллекции», «Библиотека» и коллекция-франшиза: плитки на весь экран
 * (GridScreen в modules/library/screens.js на нативной Category).
 */

/* ---------- данные ряда ---------- */

// Коллекция -> данные для Line. Иконки рядом с названием нет (модуль Line/Icon не
// подключаем): в заголовке остаётся только название или его логотип.
TH.line = function (collection) {
    return {
        title: collection.spec.title,
        results: collection.results,
        collection_id: collection.spec.id,

        // total_pages не задаём: у ряда нет страниц, нативная кнопка «Ещё» не появляется.

        params: {
            // Line сразу создаёт только первые `view` карточек (по умолчанию 7), остальные
            // достраивает по событию прокрутки. Без «Ещё» хвост коллекции терялся бы
            // (у «Форсажа» 12 фильмов), поэтому создаём все карточки ряда сразу.
            // Остальные ключи items — значения по умолчанию из Line.
            items: {
                mapping: 'line',
                align_left: false,
                view: Math.max(collection.results.length, 7)
            },

            // Название ряда -> логотип (см. TH.logos). params.emit подписывает Line
            // так же, как карточку, поэтому работает и в рядах на главной.
            emit: {
                onCreate: function () {
                    // сразу, до ответа TMDB: резерв высоты под логотип (см. TH.css)
                    if (this.html && this.html.addClass) this.html.addClass('tapokhub-line');

                    TH.logos.applyToLine(this, collection);
                }
            }
        }
    };
};

/* ---------- общие обработчики ---------- */

// Карточка: Enter открывает полную карточку. Фон подписан в самой карточке
// (см. TH.card в libraries/card.js), поэтому здесь его нет и на главной он тот же.
function bindCard(card, data) {
    card.use({
        onEnter: Lampa.Router.call.bind(Lampa.Router, 'full', data)
    });
}

/* ---------- выделение карточки и место под логотип ----------
 *
 * Нативно фокус рисует белая рамка .card.focus .card__view::after (при наведении
 * мыши — полупрозрачная .hover). Для наших карточек (класс tapokhub-card) добавляем
 * второе кольцо.
 *
 * ВАЖНО: не трогаем transform у .card__view. При «расширенной анимации» Lampa сама
 * анимирует там transform (animation-card-focus); свой scale/transition боролся бы
 * с ней: карточка подпрыгивает, проседает и рывком растёт. Тень без размытия
 * (blur) тоже намеренно: размытая тень перерисовывается на каждый фокус и
 * тормозит на слабых ТВ-приставках.
 *
 * .tapokhub-line резервирует высоту под логотип сразу, иначе при замене текста
 * картинкой каждый ряд по очереди сдвигал бы всё, что ниже.
 * .tapokhub-logo — размер логотипа вместо названия ряда.
 */
TH.css = function () {
    Lampa.Template.add('tapokhub_css', '<style>' +
        '.card.tapokhub-card.focus .card__view::after{box-shadow:0 0 0 .35em rgba(255,255,255,.35)}' +
        '.tapokhub-line .items-line__title{min-height:2.6em;display:flex;align-items:center}' +
        '.tapokhub-logo{display:block;height:2.6em;max-width:16em;object-fit:contain;object-position:left center}' +
        '.tapokhub-backdrop{position:fixed;left:0;top:0;right:0;bottom:0;z-index:1;pointer-events:none;background-color:#04040a}' +
        '.tapokhub-backdrop--blur{background-position:center;background-size:cover;background-repeat:no-repeat}' +
        '.tapokhub-backdrop--scene{background-repeat:no-repeat}' +
        '.tapokhub-toast{display:none;position:fixed;left:0;right:0;margin-left:auto;margin-right:auto;width:max-content;max-width:86vw;top:calc(env(safe-area-inset-top,0px) + 4.4em);' +
            'z-index:100000;padding:.6em 1.1em;border-radius:.7em;background:rgba(20,22,26,.94);color:#fff;font-size:1.05em;text-align:center;pointer-events:none}' +
        '.tapokhub-toast.is-on{display:block}' +
        '.card.tapokhub-off{opacity:.4}' +
        '.tapokhub-badge{position:absolute;left:.5em;top:.5em;z-index:2;padding:.15em .55em;border-radius:.4em;background:#ffd24a;color:#000;font-size:.85em;font-weight:700}' +
        '.tapokhub-badge--off{background:#555;color:#fff}' +
        '.card.tapokhub-action .card__img{display:none}' +
        '.card.tapokhub-action .card__view{background:rgba(255,255,255,.08);padding-bottom:0;height:5.5em}' +
        '.card.tapokhub-action--on .card__view{background:rgba(255,255,255,.24)}' +
        '.card.tapokhub-action .card__age,.card.tapokhub-action .card__vote{display:none}' +
        '.tapokhub-action__body{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;color:#fff}' +
        '.tapokhub-action__body svg{width:38%;height:auto;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}' +
        '.mapping--grid > .tapokhub-head{width:100%;padding-top:1em}' +
        '.tapokhub-head__title{font-size:1.5em;opacity:.9}' +
        '.tapokhub-head--big .tapokhub-head__title{font-size:2.4em;opacity:1}' +
        '.tapokhub-head .tapokhub-logo{height:auto;max-height:5em;max-width:min(80%,22em)}' +
        '.tapokhub-head--big .tapokhub-logo{max-height:8em;max-width:min(90%,32em)}' +
        '.cols--6 > .card--collection{width:33.3333%}' +
        '@media screen and (max-width:900px){.cols--6 > .card--collection{width:50%}}' +
        '.card--collection .card__title .tapokhub-logo{height:2.4em;max-width:100%;margin:0 auto}' +
        '.button--tapokhub-lib.is-active svg,.button--tapokhub-col.is-active svg{color:#ffd24a}' +
        '.button--tapokhub-lib.is-busy,.button--tapokhub-col.is-busy{opacity:.55}' +
        '.card.tapokhub-tile--new .card__view::before{content:"NEW";position:absolute;top:.6em;left:.6em;z-index:2;padding:.15em .55em;border-radius:.4em;background:#ffd24a;color:#000;font-size:.9em;font-weight:700}' +
    '</style>');

    $('body').append(Lampa.Template.get('tapokhub_css', {}, true));
};
