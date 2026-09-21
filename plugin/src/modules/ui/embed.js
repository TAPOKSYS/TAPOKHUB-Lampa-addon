/* ---------- встраивание ---------- */

var MENU_TITLE = 'TapokHub';
var MENU_POSITION = 2;             // третий пункт бокового меню (счёт с нуля)
var MENU_PLACED = 'tapokhub_menu_placed';

// Делает пункт меню третьим. Мало переставить элемент: через полсекунды после появления нового пункта редактор меню
// Lampa расставляет всё по сохранённому порядку (Storage menu_sort), а новые пункты кладёт в конец. Поэтому порядок
// записываем и туда. Один раз: дальше пользователь переставляет пункт сам в редакторе меню, и это не сбрасывается.
function placeMenuButton(btn) {
    try {
        if (Lampa.Storage.get(MENU_PLACED, '')) return;

        var el = btn && (btn[0] || btn);
        var list = el && el.parentNode;

        if (list && list.children) {
            var items = Array.prototype.filter.call(list.children, function (n) {
                return n !== el && /(^|\s)menu__item(\s|$)/.test(n.className || '');
            });

            if (items.length > MENU_POSITION) list.insertBefore(el, items[MENU_POSITION]);
        }

        var sort = Lampa.Storage.get('menu_sort', '[]');

        if (typeof sort === 'string') sort = JSON.parse(sort);

        // порядок ещё не сохранён (первый запуск): редактор запомнит порядок на экране, где пункт уже третий
        if (Array.isArray(sort) && sort.length) {
            sort = sort.filter(function (name) { return name !== MENU_TITLE; });
            sort.splice(Math.min(MENU_POSITION, sort.length), 0, MENU_TITLE);
            Lampa.Storage.set('menu_sort', sort);
        }

        Lampa.Storage.set(MENU_PLACED, 'v1');
    } catch (e) { TH.log('menu: not placed', e && e.message); }
}

TH.placeMenuButton = placeMenuButton;   // для тестов

// Главный экран TapokHub (телевизор с XMB-меню разделов): из бокового меню и по автозапуску.
TH.openHome = function () {
    Lampa.Activity.push({
        url: '',
        title: 'TapokHub',
        component: TH.components.home,
        page: 1
    });
};

// Пункт бокового меню: открывает главный экран TapokHub.
function addMenu() {
    var icon = Lampa.Template.string('icon_collection') ||
        '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 5h16v3H4zM4 10.5h16v3H4zM4 16h16v3H4z"/></svg>';

    var button = Lampa.Menu.addButton(icon, MENU_TITLE, TH.openHome);

    placeMenuButton(button);
}

// Разделы главного экрана. Новый раздел = ещё один TH.sections.add (иконки в TH.icons).
function addSections() {
    TH.sections.add({
        id: 'library',
        get title() { return TH.t('Библиотека'); },   // геттер: язык читается при показе, а не при регистрации
        icon: TH.icons.library,
        open: function () {
            Lampa.Activity.push({ url: '', title: TH.t('Библиотека'), component: TH.components.library, page: 1 });
        }
    });

    TH.sections.add({
        id: 'recommend',
        get title() { return TH.t('Рекомендации'); },
        icon: TH.icons.picks,
        open: function () {
            Lampa.Activity.push({ url: '', title: TH.t('Рекомендации'), component: TH.components.recommend, page: 1 });
        }
    });

    TH.sections.add({
        id: 'collections',
        get title() { return Lampa.Lang.translate('tapokhub_collections'); },
        icon: TH.icons.collections,
        open: function () {
            Lampa.Activity.push({
                url: '',
                title: Lampa.Lang.translate('tapokhub_collections'),
                component: TH.components.collections,
                page: 1
            });
        }
    });
}
