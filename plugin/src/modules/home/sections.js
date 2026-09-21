/*
 * Главный экран TapokHub: ретро-комната, телевизор, XMB-меню в «стекле» экрана.
 * Повторяет организацию старого плагина (modules/home/index.js), но без его костылей:
 * старый код строил невидимые карточки Lampa только ради навигации и вручную двигал
 * оверлей скриптом. Здесь свой компонент с нативным контроллером (Controller.add('content')),
 * а положение «стекла» считает CSS.
 *
 * Разделы регистрируются через TH.sections.add(...), меню и навигация строятся из реестра.
 */

/* ---------- реестр разделов ---------- */

TH.sections = (function () {
    var list = [];

    return {
        // { id, title, icon (svg-строка), open: function () }
        add: function (section) {
            if (!section || !section.id || !section.title || typeof section.open !== 'function') return false;

            for (var i = 0; i < list.length; i++) if (list[i].id === section.id) return false;

            list.push(section);
            return true;
        },
        remove: function (id) {
            list = list.filter(function (s) { return s.id !== id; });
        },
        list: function () { return list.slice(); }
    };
})();
