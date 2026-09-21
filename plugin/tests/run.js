// Проверка плагина на заглушке Lampa. Не заменяет проверку в настоящей Lampa,
// но ловит ошибки логики, порядка вызовов и формы данных.
// Запуск: ./test/run.sh

'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var failed = 0;
async function test(name, fn) {
    try { await fn(); console.log('ok   ', name); }
    catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); }
}

/* ---------- заглушка Lampa ---------- */

var MOVIES = {
    'movie/157336': { id: 157336, title: 'Interstellar', poster_path: '/a.jpg', release_date: '2014-11-05' },
    'movie/27205': { id: 27205, title: 'Inception', poster_path: '/b.jpg', release_date: '2010-07-15' },
    // 603 намеренно отсутствует: недоступная позиция должна быть пропущена
    'tv/1396': { id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', poster_path: '/c.jpg' },
    'tv/66732': { id: 66732, name: 'Stranger Things', poster_path: '/d.jpg' }, // без original_name
    'collection/1241': {
        id: 1241, name: 'Harry Potter Collection',
        parts: [
            { id: 675, title: 'HP and the Order of the Phoenix', release_date: '2007-07-08' },
            { id: 671, title: "HP and the Philosopher's Stone", release_date: '2001-11-16' },
            { id: 672, title: 'HP and the Chamber of Secrets', release_date: '2002-11-13' }
        ]
    },
    'collection/9485': {
        id: 9485, name: 'The Fast and the Furious Collection',
        parts: [
            { id: 9799, title: 'The Fast and the Furious', release_date: '2001-06-22' },
            { id: 13804, title: 'Fast & Furious', release_date: '2009-03-12' },
            { id: 337339, title: 'The Fate of the Furious', release_date: '2017-04-12' }
        ]
    },
    // логотипы: 671 (HP1) — есть en; 9799 — пусто; 13804 — есть «без языка» и «любой»
    'movie/671/images?include_image_language=ru,en,null': { logos: [{ iso_639_1: 'en', file_path: '/hp_en.png' }] },
    'movie/9799/images?include_image_language=ru,en,null': { logos: [] },
    'movie/13804/images?include_image_language=ru,en,null': { logos: [{ iso_639_1: 'xx', file_path: '/any.png' }, { iso_639_1: null, file_path: '/ff_null.png' }] },
    'movie/384018/images?include_image_language=ru,en,null': { logos: [{ iso_639_1: 'ru', file_path: '/hobbs_ru.png' }] },
    'movie/384018': { id: 384018, title: 'Hobbs & Shaw', release_date: '2019-08-01' },
    'collection/399': {
        id: 399, name: 'Predator Collection',
        parts: [
            { id: 3, title: 'Predator 2', release_date: '1990-11-21' },
            { id: 1, title: 'Predator', release_date: '1987-06-12', backdrop_path: '/bd1.jpg' },
            { id: 2, title: 'Predators', release_date: '2010-07-07' }
        ]
    }
};

var calls = { tmdb: [], menu: [], rows: [], components: {}, activity: [], lang: null };
var listeners = [];

function makeClass(name) {
    var handlers = [];
    var obj = {
        cls: name,
        html: { classes: [], addClass: function (c) { this.classes.push(c); } },
        destroyed: false,
        built: null, emptied: false,
        use: function (h) { handlers.push(h); },
        build: function (d) { obj.built = d; },
        empty: function () { obj.emptied = true; },
        handlers: handlers,
        fire: function (ev) {
            var args = Array.prototype.slice.call(arguments, 1);
            var name = ev.charAt(0).toUpperCase() + ev.slice(1);   // как Emit: 'create' -> onCreate
            var only = null;
            handlers.forEach(function (h) { if (h['only' + name]) only = h['only' + name]; });
            if (only) return only.apply(obj, args);               // onlyX глушит все onX
            handlers.forEach(function (h) { if (h['on' + name]) h['on' + name].apply(obj, args); });
        }
    };
    if (name === 'Category') {
        // как нативная Category: build создаёт карточки в общем контейнере, дальше плагин вставляет заголовки
        obj.build = function (d) {
            obj.built = d;
            var parent = { children: [], insertBefore: function (el, ref) { this.children.splice(this.children.indexOf(ref), 0, el); } };
            obj.parent = parent;
            obj.items = d.results.map(function (c) {
                var el = { parentNode: parent, data: c };
                parent.children.push(el);
                return { render: function () { return el; } };
            });
        };
        // что видит пользователь сверху вниз: [{ hero, title, cards: [данные карточек] }]
        obj.sections = function () {
            var out = [], cur = null, hero = null;
            obj.parent.children.forEach(function (el) {
                if (el.data) { if (!cur) { cur = { title: '', cards: [] }; if (hero) { cur.hero = hero; hero = null; } out.push(cur); } cur.cards.push(el.data); return; }
                var label = el.children[0], text = label.textContent, logo = label.children && label.children[0];
                if (/--big/.test(el.className)) { hero = { title: text, logo: logo ? logo.src : null }; return; }
                cur = { title: text, logo: logo ? logo.src : null, cards: [] };
                if (hero) { cur.hero = hero; hero = null; }
                out.push(cur);
            });
            return out;
        };
    }
    return obj;
}

var lineModule = {
    MASK: { base: 0b0101 },
    add: function (mask, name) { return mask | (name === 'Icon' ? 0b1000 : 0); }
};

global.window = global;
var nativeTmdb = {
    api: function (u) { return 'https://api.native/3/' + u; },
    image: function (u) { return 'https://img.native/' + u; }
};
var nativeApi = nativeTmdb.api, nativeImage = nativeTmdb.image;
var fullHandlers = [];     // подписки Lampa.Listener.follow('full', ...)
var favAdded = [];          // что плагин добавил через Lampa.Favorite.add
var storageHandlers = [];     // подписки на Lampa.Storage.listener 'change'
var torrentFileHandlers = []; // подписки на Lampa.Listener 'torrent_file'
var tlHandlers = [];        // подписки на Lampa.Timeline.listener 'update'
var favLists = {};          // Lampa.Favorite.get({type}): history / viewed
var timeline = {};          // Lampa.Timeline.view(hash).percent
var viewedIds = [];
var viewedTv = [];          // какие из viewedIds — сериалы         // отметки «Просмотрено» в заглушке Lampa.Favorite
var touchDevice = false;    // Lampa.Utils.isTouchDevice() в заглушке
var healthMode = 'ok';       // 'ok' | 'down'
var failUrlContains = null;  // подстрока адреса, запрос к которому «падает»
var domListeners = {};
global.addEventListener = function (type, fn) { (domListeners[type] = domListeners[type] || []).push(fn); };
global.removeEventListener = function (type, fn) { domListeners[type] = (domListeners[type] || []).filter(function (x) { return x !== fn; }); };
function domFire(type, e) { (domListeners[type] || []).forEach(function (fn) { fn(e); }); }
var attached = true; // document.documentElement.contains(...)
function makeEl(tag) {
    var e = {
        tag: tag, className: '', innerHTML: '', textContent: '', children: [], parentNode: null, listeners: {}, style: {},
        appendChild: function (c) { c.parentNode = e; e.children.push(c); return c; },
        remove: function () { if (e.parentNode) e.parentNode.removeChild(e); },
        removeChild: function (c) { e.children = e.children.filter(function (x) { return x !== c; }); c.parentNode = null; },
        addEventListener: function (type, fn, opts) { (e.listeners[type] = e.listeners[type] || []).push(fn); (e.listenerOpts = e.listenerOpts || {})[type] = opts; },
        removeEventListener: function (type, fn) { e.listeners[type] = (e.listeners[type] || []).filter(function (x) { return x !== fn; }); },
        contains: function (n) { return n === e || e.children.some(function (c) { return c.contains(n); }); },
        fire: function (type, ev) { (e.listeners[type] || []).slice().forEach(function (fn) { fn(ev); }); },
        count: function (type) { return (e.listeners[type] || []).length; }
    };
    return e;
}
global.document = { documentElement: { contains: function () { return attached; } }, createElement: makeEl };
global.MouseEvent = function (type, init) { this.type = type; for (var k in init) this[k] = init[k]; };
var store = {}; // значения настроек Lampa (Storage.field)
var lstore = {}; // то, что плагин кладёт в Storage.get/set (токен устройства и т.п.)
var permit = {}; // Lampa.Account.Permit: токен и профиль аккаунта CUB
var imageMode = 'ok'; // 'ok' | 'error': поведение заглушки Image
global.Image = function () {
    var self = this, src = '';
    Object.defineProperty(this, 'src', {
        get: function () { return src; },
        set: function (v) {
            src = v;
            setTimeout(function () {
                if (imageMode === 'ok' && self.onload) self.onload();
                if (imageMode === 'error' && self.onerror) self.onerror();
            }, 1);
        }
    });
};
global.$ = function (sel) { return { append: function (html) { calls.appended = calls.appended || []; calls.appended.push({ to: sel, html: html }); } }; };
global.console = console;
global.Lampa = {
    Manifest: { app_digital: 334, cub_domain: 'cub.test' },
    Account: { Permit: permit },
    Storage: { get: function (k, d) { return Object.prototype.hasOwnProperty.call(lstore, k) ? lstore[k] : d; }, set: function (k, v, nolisten) { lstore[k] = v; if (!nolisten) storageHandlers.forEach(function (h) { h({ name: k, value: v }); }); },
        listener: { follow: function (n, fn) { if (n === 'change') storageHandlers.push(fn); } },
        field: function (k) {
        if (Object.prototype.hasOwnProperty.call(store, k)) return store[k];
        if (k === 'tmdb_lang') return 'ru-RU';
        // как настоящая Lampa: значение по умолчанию из зарегистрированного параметра
        var reg = (calls.settingsParams || []).filter(function (p) { return p.param.name === k; })[0];
        return reg ? reg.param.default : undefined;
    } },
    SettingsApi: {
        addComponent: function (c) { calls.settingsComponent = c; },
        addParam: function (p) { (calls.settingsParams = calls.settingsParams || []).push(p); }
    },
    Listener: { follow: function (n, fn) { if (n === 'full') fullHandlers.push(fn); else if (n === 'torrent_file') torrentFileHandlers.push(fn); else listeners.push(fn); } },
    Maker: {
        make: function (name, object) { return makeClass(name); },
        module: function () { throw new Error('Maker.module не должен вызываться: модуль Icon не используется'); }
    },
    Template: {
        string: function (n) { return n === 'icon_collection' ? '<svg>c</svg>' : ''; },
        add: function (n, html) { calls.templates = calls.templates || {}; calls.templates[n] = html; },
        get: function (n) { return calls.templates[n]; }
    },
    Lang: { add: function (d) { calls.lang = d; }, translate: function (k) { return calls.lang[k] ? calls.lang[k].ru : k; } },
    Component: { add: function (n, c) { calls.components[n] = c; } },
    Menu: { addButton: function (icon, title, fn) { calls.menu.push({ icon: icon, title: title, fn: fn }); } },
    ContentRows: { add: function (r) { calls.rows.push(r); } },
    Activity: { active: function () { return calls.activeActivity; }, push: function (o) { calls.activity.push(o); }, replace: function (o) { (calls.replaced = calls.replaced || []).push(o); }, backward: function () { calls.backward = (calls.backward || 0) + 1; } },
    Controller: {
        add: function (n, h) { calls.controllers = calls.controllers || {}; calls.controllers[n] = h; },
        toggle: function (n) { calls.toggled = (calls.toggled || []).concat(n); },
        enabled: function () { return { name: 'full_start' }; },
        clear: function () { calls.cleared = (calls.cleared || 0) + 1; }
    },
    Noty: { show: function (m) { (calls.noty = calls.noty || []).push(m); } },
    Select: { show: function (o) { calls.select = o; } },
    Favorite: { check: function (c) { return { viewed: viewedIds.indexOf(c.id) > -1 }; },
        get: function (p) {   // отметки «Просмотрено»: карточки с видом (сериал — original_name), как в настоящей Lampa
            if (p.type !== 'viewed') return favLists[p.type] || [];
            return (favLists.viewed || []).concat(viewedIds.map(function (id) { return viewedTv.indexOf(id) > -1 ? { id: id, original_name: 'tv' } : { id: id, original_title: 'movie' }; }));
        },
        add: function (where, card) { (favAdded = favAdded || []).push([where, card.id]); if (where === 'viewed') viewedIds.push(card.id); } },
    Timeline: { view: function (h) { return { percent: timeline[h] || 0 }; }, listener: { follow: function (n, fn) { if (n === 'update') tlHandlers.push(fn); } } },
    Input: { edit: function (p, cb) { calls.input = { params: p, cb: cb }; } },
    Router: { call: function () { calls.routed = Array.prototype.slice.call(arguments); } },
    Background: { change: function (u) { calls.bg = u; } },
    TMDB: nativeTmdb,
    Reguest: function () {
        this.timeout = function () {};
        this.silent = function (url, ok, err) {
            calls.health = (calls.health || []).concat(url);
            setTimeout(function () {
                if (healthMode === 'ok') ok({ ok: true }); else err();
            }, 1);
        };
    },
    Api: { sources: { tmdb: { get: function (p, params, ok, fail, cache) {
        var u = p + (p.indexOf('?') > -1 ? '&' : '?') + 'api_key=KEY&language=ru';   // как url() в sources/tmdb.js
        var final = Lampa.TMDB.api(u);                                                // адрес строит (подменяемая) TMDB.api
        calls.tmdb.push({ path: p, cache: cache, url: final });
        setTimeout(function () {
            if (failUrlContains && final.indexOf(failUrlContains) > -1) return fail();
            if (MOVIES[p]) ok(JSON.parse(JSON.stringify(MOVIES[p]))); else fail();
        }, 1);
    } } }, img: function (path, size) { return 'img:' + size + path; } },
    Utils: { hash: function (s) { return 'h:' + s; }, cardImgBackground: function (d) { return 'native:' + d.id; }, isTouchDevice: function () { return touchDevice; } }
};

// Как Utils.createInstance: params.emit карточки подписывается на неё сразу.
function newCard(data) {
    var card = makeClass('Card');
    if (data && data.params && data.params.emit) card.use(data.params.emit);
    return card;
}

// Line с подписанным params.emit и фейковым DOM заголовка (.items-line__title).
function newLine(data) {
    var title = { parentNode: {}, innerHTML: 'Название', children: [], appendChild: function (c) { this.children.push(c); } };
    var line = makeClass('Line');
    line.classes = [];
    line.html = { addClass: function (c) { line.classes.push(c); }, querySelector: function (sel) {
        return sel === '.items-line__title' ? title : null;
    } };
    line.name = title; // короткий алиас для проверок
    if (data.params && data.params.emit) line.use(data.params.emit);
    return line;
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------- загрузка плагина ---------- */

// Тесты идут на отдельной сборке БЕЗ адреса сервера (plugin/build.py без флагов): dist/tapokhub.test.js.
// Боевую сборку с прокси делает `make build` (plugin/build.py --auto-proxy).
var file = path.join(__dirname, '..', '..', 'dist', 'tapokhub.test.js');
new Function(fs.readFileSync(file, 'utf8')).call(global); // синтаксис + выполнение

// В плагине нет готовых коллекций (их создаёт пользователь на сервере). Ядро проверяем на своих тестовых.
window.TapokHub.collections.add({ id: 'harry-potter', title: 'Гарри Поттер', home: true, tmdb_collection: 1241 });
window.TapokHub.collections.add({ id: 'fast-furious', title: 'Форсаж', home: true, tmdb_collection: 9485, extras: [{ type: 'movie', id: 384018 }] });
window.TapokHub.collections.add({ id: 'test-predator', title: 'Тест: Хищник', home: false, tmdb_collection: 399 });
window.TapokHub.collections.add({ id: 'test-mixed', title: 'Тест: смешанная подборка', home: false, items: [
    { type: 'movie', id: 157336 }, { type: 'movie', id: 27205 }, { type: 'movie', id: 603 }, { type: 'tv', id: 1396 }, { type: 'tv', id: 66732 }] });

(async function () {
    await test('плагин экспортирует TapokHub и ждёт app:ready', function () {
        assert.ok(window.TapokHub, 'window.TapokHub');
        assert.strictEqual(listeners.length, 1, 'подписка на app');
        assert.strictEqual(calls.menu.length, 0, 'до ready меню не трогаем');
    });

    await test('двойная загрузка не дублирует подписки', function () {
        new Function(fs.readFileSync(file, 'utf8')).call(global);
        assert.strictEqual(listeners.length, 1);
    });

    listeners[0]({ type: 'ready' });

    await test('init: компоненты и меню', function () {
        assert.ok(calls.components.tapokhub_collections);
        assert.strictEqual(calls.components.tapokhub_collection, undefined, 'экрана «Ещё» (сетки) быть не должно');
        assert.ok(calls.components.tapokhub_home, 'главный экран зарегистрирован');
        assert.strictEqual(calls.menu.length, 1);
        assert.strictEqual(calls.menu[0].title, 'TapokHub');
        assert.strictEqual(calls.rows.length, 0, 'своих рядов на главной Lampa нет');
    });

    await test('стили вставлены один раз и только на наши элементы', function () {
        assert.strictEqual(calls.appended.length, 2, 'стили карточек и стили главного экрана');
        var css = calls.appended[0].html;
        assert.ok(calls.appended[0].to === 'body');
        assert.ok(/\.card\.tapokhub-card\.focus/.test(css), 'селектор фокуса нашей карточки');
        assert.ok(/\.tapokhub-line/.test(css), 'резерв места под логотип');
        assert.ok(!/(^|[}\s,])\.card\.focus/.test(css.replace(/\.card\.tapokhub-card/g, '')), 'нет глобальных правил на все карточки');
    });

    await test('стили не воюют с нативной анимацией фокуса Lampa', function () {
        var css = calls.appended[0].html;
        assert.ok(!/transform|transition|animation|scale\(/i.test(css), 'transform/transition/animation конфликтуют с animation-card-focus');
        // тень только без размытия: у box-shadow третье число (blur) должно быть 0
        (css.match(/box-shadow:[^;}]*/g) || []).forEach(function (rule) {
            var nums = rule.replace('box-shadow:', '').trim().split(/\s+/).filter(function (x) { return /^-?[\d.]+(em|px)?$/.test(x); });
            assert.strictEqual(parseFloat(nums[2]), 0, 'blur должен быть 0: ' + rule);
        });
    });

    await test('под логотип место резервируется до ответа TMDB (нет сдвига вёрстки)', function () {
        var css = calls.appended[0].html;
        var minH = css.match(/\.tapokhub-line[^{]*\{[^}]*min-height:([\d.]+)em/);
        var logoH = css.match(/\.tapokhub-logo\{[^}]*height:([\d.]+)em/);
        assert.ok(minH && logoH, 'нашлись оба правила');
        assert.ok(parseFloat(minH[1]) >= parseFloat(logoH[1]), 'резерв не меньше высоты логотипа');
    });

    await test('ряд получает класс tapokhub-line синхронно при создании', function () {
        var line = newLine(window.TapokHub.line({ spec: { id: 'z', title: 'z' }, results: [] }));
        line.fire('create');
        assert.deepStrictEqual(line.classes, ['tapokhub-line']); // без ожидания ответа
    });

    await test('карточка получает класс tapokhub-card при создании', function () {
        var card = { html: { classes: [], addClass: function (c) { this.classes.push(c); } } };
        var data = window.TapokHub.card({ id: 1, title: 'x' }, 'movie');
        // как createInstance: params.emit подписывается, затем Card.create() эмитит create
        var handlers = [data.params.emit];
        handlers.forEach(function (h) { if (h.onCreate) h.onCreate.call(card); });
        assert.deepStrictEqual(card.html.classes, ['tapokhub-card']);
    });


    await test('пункт меню открывает главный экран TapokHub', function () {
        calls.menu[0].fn();
        assert.strictEqual(calls.activity[0].component, 'tapokhub_home');
        assert.strictEqual(calls.activity[0].title, 'TapokHub');
    });

    var TH = window.TapokHub;

    // Старые проверки главного экрана писались для одного раздела: на их время «Библиотеку» убираем из реестра.
    var libSection = TH.sections.list().filter(function (s) { return s.id === 'library'; })[0];
    var recSection = TH.sections.list().filter(function (s) { return s.id === 'recommend'; })[0];
    TH.sections.remove('library'); TH.sections.remove('recommend');

    /* ---------- главный экран (телевизор + XMB) ---------- */

    var Home = calls.components.tapokhub_home;
    var newHome = function () { var h = new Home({}); h.create(); return h; };
    var tapAt = function (root, target, x, y, moves, hold) {
        var realNow = Date.now, now = realNow();
        if (hold) Date.now = function () { return now; };
        root.fire('touchstart', { touches: [{ clientX: x, clientY: y }], target: target });
        if (hold) now += hold;
        root.fire('touchend', { changedTouches: [{ clientX: x + (moves ? moves[0] : 0), clientY: y + (moves ? moves[1] : 0) }], target: target });
        if (hold) Date.now = realNow;
    };
    var inScreen = function (root) { return root.children[0].children[0].children[1]; };   // иконка внутри «стекла»
    var stageEl = function (root) { return root.children[0]; };

    await test('главный экран: реестр разделов', function () {
        assert.deepStrictEqual(TH.sections.list().map(function (s) { return s.id; }), ['collections'], 'на старте — только «Коллекции»');
        assert.strictEqual(TH.sections.add({ id: 'collections', title: 'dup', open: function () {} }), false, 'дубль отклоняется');
        assert.strictEqual(TH.sections.add({ id: 'x', title: 'no open' }), false);
        assert.strictEqual(TH.sections.add({ title: 't', open: function () {} }), false);
        assert.ok(TH.sections.list()[0].icon.indexOf('<svg') === 0);
    });

    await test('главный экран: на всё окно (под шапкой и нижней панелью), фон Lampa сбрасывается при входе и выходе', function () {
        var css = calls.appended[1].html;
        assert.ok(/\.tapokhub-home\{position:fixed;left:0;top:0;right:0;bottom:0/.test(css), 'корень занимает всё окно, а не область под шапкой');
        var h = newHome();
        calls.bg = 'kadr-filma';
        h.start();
        assert.ok(/^data:image\/png/.test(calls.bg), 'при входе и возврате с дочернего экрана: кадр фильма убран');
        calls.bg = 'kadr-filma';
        h.destroy();
        assert.ok(/^data:image\/png/.test(calls.bg), 'при выходе в меню Lampa: тоже сброс');
    });

    await test('главный экран: меню не сдвигает сцену (сцена на всё окно и под меню), метка на body только пока экран открыт', function () {
        var css = calls.appended[1].html;
        assert.ok(/body\.tapokhub-home-on\.menu--open:not\(\.light--version\) \.wrap__content,body\.tapokhub-home-on\.menu--always\.menu--open:not\(\.light--version\) \.wrap__content\{transform:none\}/.test(css), 'и с постоянной полосой меню (ТВ)');
        var classes = {};
        var savedBody = document.body;
        document.body = { appendChild: function () {}, classList: { add: function (c) { classes[c] = true; }, remove: function (c) { delete classes[c]; } } };
        try {
            var h = newHome();
            h.start(); assert.ok(classes['tapokhub-home-on'], 'после start метка есть');
            h.pause(); assert.ok(!classes['tapokhub-home-on'], 'на pause убрана: остальные экраны Lampa сдвигаются как обычно');
            h.start(); h.stop(); assert.ok(!classes['tapokhub-home-on']);
            h.start(); h.destroy(); assert.ok(!classes['tapokhub-home-on'], 'и на destroy');
        } finally { document.body = savedBody; }
    });

    await test('главный экран: общий слой рисует ту же картинку в координатах сцены (продолжается под полосой меню ТВ и шапкой)', async function () {
        var savedBody = document.body;
        document.body = { appendChild: function () {}, classList: { add: function () {}, remove: function () {} } };
        var savedLayer = TH.backdrop.owner();
        try {
            TH.backdrop.hide(savedLayer);
            var h = newHome();
            var stage = h.render(true).children[0];
            stage.getBoundingClientRect = function () { return { left: 40.5, top: -20, width: 1280, height: 720.4 }; };
            h.start();
            var layerStyle = TH.backdrop.element().style;
            assert.strictEqual(TH.backdrop.element().className, 'tapokhub-backdrop tapokhub-backdrop--scene');
            assert.strictEqual(layerStyle.backgroundPosition, '40.5px -20px');
            assert.strictEqual(layerStyle.backgroundSize, '1280px 720.4px');
            stage.getBoundingClientRect = function () { return { left: 0, top: 0, width: 1000, height: 562.8 }; };
            await wait(450);
            assert.strictEqual(layerStyle.backgroundPosition, '0px 0px', 'после раскладки положение уточняется');
            assert.strictEqual(layerStyle.backgroundSize, '1000px 562.8px');
            h.destroy();
            assert.strictEqual(layerStyle.display, 'none');
        } finally { document.body = savedBody; }
    });

    await test('главный экран: create строит телевизор и показывает первый раздел', function () {
        var h = newHome(), root = h.render(true);
        assert.strictEqual(root.className, 'tapokhub-home');
        assert.strictEqual(stageEl(root).className, 'tapokhub-home__stage');
        var screen = stageEl(root).children[0];
        assert.strictEqual(screen.className, 'tapokhub-home__screen');
        var byClass = function (c) { return screen.children.filter(function (x) { return x.className.indexOf(c) === 0; })[0]; };
        assert.strictEqual(byClass('tapokhub-home__label').textContent, 'Коллекции');
        assert.ok(byClass('tapokhub-home__icon').innerHTML.indexOf('<svg') === 0);
        assert.strictEqual(byClass('tapokhub-home__hint').textContent, 'НАЖМИТЕ  OK', 'один раздел: стрелок нет');
        assert.ok(byClass('tapokhub-home__hint').className.indexOf('is-nav') === -1, 'стрелок нет');
        assert.strictEqual(byClass('tapokhub-home__dots').innerHTML, '', 'точек-индикаторов нет, выбирать не из чего');
    });

    await test('главный экран: контроллер content — enter открывает раздел, back выходит', function () {
        var h = newHome(); h.start();
        var c = calls.controllers.content;
        assert.ok(c && c.left && c.right && c.up && c.down && c.enter && c.back && c.toggle);
        assert.strictEqual(calls.toggled[calls.toggled.length - 1], 'content', 'контроллер активирован');
        c.toggle(); assert.ok(calls.cleared > 0, 'пул Navigator очищен: фокусируемых элементов нет');
        var n = calls.activity.length;
        c.enter();
        assert.strictEqual(calls.activity.length, n + 1);
        assert.strictEqual(calls.activity[n].component, 'tapokhub_collections');
        assert.strictEqual(calls.activity[n].title, 'Коллекции');
        var b = calls.backward || 0; c.back(); assert.strictEqual(calls.backward, b + 1);
    });

    await test('главный экран: start растягивает контейнер активности на всю высоту', function () {
        var h = newHome(), parent = makeEl('div');
        parent.appendChild(h.render(true));
        h.start();
        assert.strictEqual(parent.style.height, '100%', '.activity__body не имеет своей высоты, без этого экран схлопывается в 0');
        var orphan = newHome();
        orphan.start();   // без родителя (ещё не вставлен) — не падаем
    });

    await test('главный экран: у левого края влево открывает боковое меню, вверх — шапку', function () {
        var h = newHome(); h.start();
        var c = calls.controllers.content;
        c.left(); assert.strictEqual(calls.toggled[calls.toggled.length - 1], 'menu');
        c.up(); assert.strictEqual(calls.toggled[calls.toggled.length - 1], 'head');
        var before = calls.toggled.length;
        c.right(); c.down();
        assert.strictEqual(calls.toggled.length, before, 'вправо и вниз при одном разделе ничего не делают');
        assert.strictEqual(h.state().index, 0);
    });

    await test('главный экран: несколько разделов — листание, границы, индикатор, подсказка', function () {
        var opened = [];
        ['b', 'c'].forEach(function (id) { TH.sections.add({ id: id, title: 'Раздел ' + id.toUpperCase(), icon: '<svg>' + id + '</svg>', open: function () { opened.push(id); } }); });
        try {
            var h = newHome(); h.start();
            var screen = stageEl(h.render(true)).children[0];
            var get = function (c) { return screen.children.filter(function (x) { return x.className.indexOf(c) === 0; })[0]; };
            var c = calls.controllers.content;
            assert.strictEqual(get('tapokhub-home__hint').textContent, 'ВЫБЕРИТЕ РАЗДЕЛ');
            assert.ok(get('tapokhub-home__hint').className.indexOf('is-nav') > -1, 'стрелки рисует CSS');
            assert.strictEqual((get('tapokhub-home__dots').innerHTML.match(/<b/g) || []).length, 3, 'по точке на раздел');
            assert.ok(/is-active">●<\/b><b class=""/.test(get('tapokhub-home__dots').innerHTML), 'активна первая');
            c.right(); assert.strictEqual(get('tapokhub-home__label').textContent, 'Раздел B');
            assert.strictEqual(get('tapokhub-home__icon').innerHTML, '<svg>b</svg>');
            c.right(); c.right(); c.right();
            assert.strictEqual(h.state().index, 2, 'правее последнего не уходим');
            assert.strictEqual(get('tapokhub-home__label').textContent, 'Раздел C');
            c.enter(); assert.deepStrictEqual(opened, ['c']);
            c.left(); c.left();
            assert.strictEqual(h.state().index, 0);
            var t = calls.toggled.length; c.left();
            assert.strictEqual(calls.toggled[t], 'menu', 'у левого края — боковое меню');
        } finally { TH.sections.remove('b'); TH.sections.remove('c'); }
    });

    await test('главный экран: положение сохраняется при возврате с дочернего экрана', function () {
        TH.sections.add({ id: 'r1', title: 'R1', icon: '', open: function () {} });
        try {
            var h = newHome(); h.start();
            calls.controllers.content.right();
            h.start();   // Activity вызывает start снова после возврата
            assert.strictEqual(h.state().index, 1);
        } finally { TH.sections.remove('r1'); }
    });

    await test('главный экран, тач: тап по «стеклу» открывает раздел (с допуском смещения 14 px)', function () {
        var h = newHome(), root = h.render(true), screenEl = stageEl(root).children[0];
        var n = calls.activity.length;
        tapAt(root, inScreen(root), 100, 100);
        assert.strictEqual(calls.activity.length, n + 1, 'точный тап');
        tapAt(root, inScreen(root), 100, 100, [10, 6]);
        assert.strictEqual(calls.activity.length, n + 2, 'лёгкое касание с дрожанием пальца');
        tapAt(root, inScreen(root), 100, 100, [20, 0]);
        assert.strictEqual(calls.activity.length, n + 2, 'смещение 20 px — не тап');
    });

    await test('главный экран, тач: тап вне «стекла», долгое нажатие и два пальца не открывают', function () {
        var h = newHome(), root = h.render(true);
        var n = calls.activity.length;
        tapAt(root, stageEl(root), 10, 10);                           // по фону комнаты
        tapAt(root, inScreen(root), 100, 100, null, 900);             // долго
        root.fire('touchstart', { touches: [{ clientX: 1, clientY: 1 }, { clientX: 5, clientY: 5 }], target: inScreen(root) });
        root.fire('touchend', { changedTouches: [{ clientX: 1, clientY: 1 }], target: inScreen(root) });
        assert.strictEqual(calls.activity.length, n);
    });

    await test('главный экран, тач: горизонтальный свайп листает разделы, вертикальный нет', function () {
        TH.sections.add({ id: 's2', title: 'S2', icon: '', open: function () {} });
        try {
            var h = newHome(), root = h.render(true);
            var n = calls.activity.length;
            tapAt(root, inScreen(root), 200, 100, [-60, 4]);           // влево -> следующий
            assert.strictEqual(h.state().index, 1);
            tapAt(root, inScreen(root), 200, 100, [60, -4]);           // вправо -> предыдущий
            assert.strictEqual(h.state().index, 0);
            tapAt(root, inScreen(root), 200, 100, [4, -80]);           // вертикальный
            assert.strictEqual(h.state().index, 0);
            assert.strictEqual(calls.activity.length, n, 'свайп ничего не открывает');
        } finally { TH.sections.remove('s2'); }
    });

    await test('главный экран, тач: обработанное касание отменяет призрачный click (иначе он попал бы в новый экран)', function () {
        TH.sections.add({ id: 'g2', title: 'G2', icon: '', open: function () {} });
        try {
            var h = newHome(), root = h.render(true), prevented = 0;
            var fireEnd = function (x, y, tx, ty, target) {
                root.fire('touchstart', { touches: [{ clientX: tx, clientY: ty }], target: target });
                root.fire('touchend', { changedTouches: [{ clientX: x, clientY: y }], target: target, cancelable: true, preventDefault: function () { prevented++; } });
            };
            fireEnd(100, 100, 100, 100, inScreen(root));   // тап по «стеклу»
            assert.strictEqual(prevented, 1, 'тап');
            fireEnd(40, 100, 100, 100, inScreen(root));    // свайп
            assert.strictEqual(prevented, 2, 'свайп');
            fireEnd(100, 100, 100, 100, stageEl(root));    // тап мимо «стекла»: не наш, click не трогаем
            assert.strictEqual(prevented, 2, 'необработанное касание не отменяем');
            assert.strictEqual(root.listenerOpts.touchend.passive, false, 'touchend не passive, иначе preventDefault не сработает');
            assert.strictEqual(root.listenerOpts.touchstart.passive, true, 'touchstart passive: прокрутку не задерживаем');
        } finally { TH.sections.remove('g2'); }
    });

    await test('главный экран, мышь: click открывает, но не дублирует только что обработанный тач', function () {
        var h = newHome(), root = h.render(true), n = calls.activity.length;
        root.fire('click', { target: inScreen(root) });
        assert.strictEqual(calls.activity.length, n + 1, 'мышь по «стеклу»');
        root.fire('click', { target: stageEl(root) });
        assert.strictEqual(calls.activity.length, n + 1, 'мышь мимо «стекла»');
        tapAt(root, inScreen(root), 100, 100);                        // тач открыл ...
        root.fire('click', { target: inScreen(root) });               // ... и браузер прислал click
        assert.strictEqual(calls.activity.length, n + 2, 'click после тапа игнорируется');
    });

    await test('главный экран: destroy снимает слушатели и убирает экран', function () {
        var h = newHome(), root = h.render(true), parent = makeEl('div');
        parent.appendChild(root);
        ['touchstart', 'touchend', 'click'].forEach(function (ev) { assert.strictEqual(root.count(ev), 1, ev); });
        h.destroy();
        ['touchstart', 'touchend', 'click'].forEach(function (ev) { assert.strictEqual(root.count(ev), 0, ev); });
        assert.strictEqual(root.parentNode, null);
    });

    await test('главный экран: «стекло» задано долями кадра 1672x941 (как в старом плагине)', function () {
        var css = calls.appended[1].html;
        var pct = function (v, of) { return (Math.round(v / of * 10000) / 100) + '%'; };
        assert.ok(css.indexOf('left:' + pct(520, 1672)) > -1, 'left ' + pct(520, 1672));
        assert.ok(css.indexOf('top:' + pct(184, 941)) > -1, 'top ' + pct(184, 941));
        assert.ok(css.indexOf('width:' + pct(660, 1672)) > -1, 'width ' + pct(660, 1672));
        assert.ok(css.indexOf('height:' + pct(365, 941)) > -1, 'height ' + pct(365, 941));
        assert.ok(css.indexOf('*' + (Math.round(941 / 1672 * 10000) / 10000)) > -1, 'сцена сохраняет пропорции кадра');
        assert.ok(css.indexOf('min(max(100vw,177.68vh),230vw)') > -1, 'cover, но не шире 230% ширины окна (телефон в портрете)');
    });

    await test('главный экран: стили лёгкие — без размытия и без transition, свои классы', function () {
        var css = calls.appended[1].html;
        assert.ok(!/blur\(/.test(css) && !/transition/.test(css), 'дорогих эффектов нет');
        (css.match(/[^{}]+\{/g) || []).forEach(function (sel) {
            if (/^@keyframes|^\s*(\d+(\.\d+)?%|from|to)\s*\{?$/.test(sel.trim()) || /^\d+%\s*\{/.test(sel.trim())) return;   // шаги анимации
            assert.ok(/tapokhub-home|^@/.test(sel.trim()) || /^(0%|49%)/.test(sel.trim()) || sel.trim().indexOf('{') === 0, 'селектор вне .tapokhub-home: ' + sel);
        });
    });

    await test('главный экран: подсказка без спецсимволов ◀ ▶, стрелки нарисованы CSS', function () {
        var css = calls.appended[1].html;
        assert.ok(!/[◀▶◄►]/.test(css) && !/[◀▶◄►]/.test(new Home({}).render(true).children[0].children[0].children[3].textContent), 'символов нет ни в стиле, ни в тексте');
        assert.ok(/\.is-nav::before/.test(css) && /\.is-nav::after/.test(css), 'стрелки слева и справа');
    });

    await test('главный экран: адрес фона строится из assetsBase, без сборки картинок его нет', function () {
        assert.strictEqual(TH.assetUrl('menu-background.jpg'), '', 'в тестовой сборке картинок нет');
        var b = TH.assetsBase, v = TH.assetsVersion;
        TH.assetsBase = 'https://h.test/assets/'; TH.assetsVersion = 'abc123';
        assert.strictEqual(TH.assetUrl('menu-background.jpg'), 'https://h.test/assets/menu-background.jpg?v=abc123');
        TH.assetsVersion = '@@ASSETS_VERSION@@';
        assert.strictEqual(TH.assetUrl('x.jpg'), 'https://h.test/assets/x.jpg', 'без версии — без параметра');
        TH.assetsBase = b; TH.assetsVersion = v;
    });

    // вернуть реестр как в плагине: «Библиотека» первая, «Коллекции» вторая
    var colSection = TH.sections.list().filter(function (s) { return s.id === 'collections'; })[0];
    TH.sections.remove('collections'); TH.sections.add(libSection); TH.sections.add(recSection); TH.sections.add(colSection);



    await (async function () {
        var lines;
        // экран-сетка: сюда приходят карточки (Category), ряды TH.line проверяем отдельно
        var comp = calls.components.tapokhub_collections({});
        var resolved = await new Promise(function (r) { TH.collections.resolveAll(null, r); });
        lines = resolved.map(TH.line);

        function L(id) { return lines.filter(function (l) { return l.collection_id === id; })[0]; }

        await test('реестр: коллекции в порядке добавления, ряды строит TH.line', function () {
            assert.deepStrictEqual(lines.map(function (l) { return l.collection_id; }),
                ['harry-potter', 'fast-furious', 'test-predator', 'test-mixed']);
        });

        await test('Гарри Поттер: 3 части, по дате выхода', function () {
            var l = L('harry-potter');
            assert.strictEqual(l.title, 'Гарри Поттер');
            assert.deepStrictEqual(l.results.map(function (c) { return c.id; }), [671, 672, 675]);
        });

        await test('Форсаж: спин-офф из extras добавлен и стоит по дате выхода', function () {
            var l = L('fast-furious');
            assert.strictEqual(l.title, 'Форсаж');
            // 2001, 2009, 2017 (Форсаж 8), 2019 (Хоббс и Шоу из extras)
            assert.deepStrictEqual(l.results.map(function (c) { return c.id; }), [9799, 13804, 337339, 384018]);
            assert.strictEqual(l.results[3].media_type, 'movie');
        });

        await test('extras: позиция, уже входящая в коллекцию TMDB, не дублируется', async function () {
            TH.collections.add({ id: 'dupe', title: 'dupe', tmdb_collection: 9485,
                extras: [{ type: 'movie', id: 9799 }, { type: 'movie', id: 384018 }] });
            var res = await new Promise(function (r) { TH.collections.resolve('dupe', r); });
            var ids = res.results.map(function (c) { return c.id; });
            assert.deepStrictEqual(ids, [9799, 13804, 337339, 384018]);
        });

        await test('франшиза: части отсортированы по дате выхода', function () {
            var l = L('test-predator');
            assert.strictEqual(l.title, 'Тест: Хищник');
            assert.deepStrictEqual(l.results.map(function (c) { return c.id; }), [1, 3, 2]); // 1987, 1990, 2010
        });

        await test('подборка: порядок сохранён, недоступная позиция пропущена', function () {
            var ids = L('test-mixed').results.map(function (c) { return c.id; });
            assert.deepStrictEqual(ids, [157336, 27205, 1396, 66732]);
        });

        await test('карточки: source, media_type и original_name у сериала', function () {
            var tv = L('test-mixed').results[3];
            assert.strictEqual(tv.source, 'tmdb');
            assert.strictEqual(tv.media_type, 'tv');
            assert.strictEqual(tv.original_name, 'Stranger Things');
            assert.strictEqual(L('test-mixed').results[0].media_type, 'movie');
        });

        await test('ряд: без иконки рядом с названием и без кнопки «Ещё»', function () {
            var l = L('test-mixed');
            assert.strictEqual(l.icon_svg, undefined, 'icon_svg не задаём');
            assert.strictEqual(l.icon_color, undefined);
            assert.strictEqual(l.icon_bgcolor, undefined);
            assert.strictEqual(l.params.module, undefined, 'модуль Line/Icon не подключается (только базовый набор)');
            assert.ok(!(l.total_pages > 1), 'total_pages > 1 включил бы нативную кнопку «Ещё»');
            assert.strictEqual(l.collection_id, 'test-mixed');
            assert.strictEqual(l.title, 'Тест: смешанная подборка');
        });

        await test('ряд: создаются все карточки коллекции сразу (без «Ещё» хвост не теряется)', function () {
            var hp = L('harry-potter'), ff = L('fast-furious');
            assert.ok(hp.params.items.view >= hp.results.length);
            assert.ok(ff.params.items.view >= ff.results.length);
            assert.ok(L('test-mixed').params.items.view >= 7, 'для коротких рядов не меньше нативных 7');
            assert.strictEqual(hp.params.items.mapping, 'line', 'остальные ключи items как в Line');
            // «Форсаж» в живом TMDB — 12 фильмов: view должен это покрывать
            var big = window.TapokHub.line({ spec: { id: 'x', title: 'x' }, results: new Array(12).fill({ id: 1 }) });
            assert.strictEqual(big.params.items.view, 12);
        });

        await test('логотип: выбор по языку интерфейса -> en -> без языка -> любой', function () {
            var pick = TH.logos.pick;
            var de = { iso_639_1: 'de', file_path: '/de' }, en = { iso_639_1: 'en', file_path: '/en' },
                ru = { iso_639_1: 'ru', file_path: '/ru' }, no = { iso_639_1: null, file_path: '/null' };
            assert.strictEqual(pick([de, en, ru, no]).file_path, '/ru');   // язык интерфейса ru-RU
            assert.strictEqual(pick([de, no, en]).file_path, '/en');
            assert.strictEqual(pick([de, no]).file_path, '/null');
            assert.strictEqual(pick([de]).file_path, '/de');
            assert.strictEqual(pick([{ iso_639_1: 'ru' }]), null, 'без file_path не подходит');
            assert.strictEqual(pick([]), null);
            assert.strictEqual(pick(null), null);
        });

        await test('логотип: ряд «Гарри Поттер» — название заменено картинкой', async function () {
            imageMode = 'ok';
            var line = newLine(L('harry-potter'));
            line.fire('create');
            await wait(30);
            assert.strictEqual(line.name.children.length, 1, 'картинка вставлена');
            var img = line.name.children[0];
            assert.strictEqual(img.src, 'img:w500/hp_en.png');
            assert.strictEqual(img.className, 'tapokhub-logo');
            assert.strictEqual(img.alt, 'Гарри Поттер');
            assert.strictEqual(line.name.innerHTML, '', 'текст убран');
        });

        await test('логотип: у первого фильма нет — берётся следующий, «без языка» лучше «любого»', async function () {
            var before = calls.tmdb.length;
            var line = newLine(L('fast-furious'));
            line.fire('create');
            await wait(40);
            assert.strictEqual(line.name.children[0].src, 'img:w500/ff_null.png');
            var asked = calls.tmdb.slice(before).map(function (c) { return c.path; });
            assert.deepStrictEqual(asked, [
                'movie/9799/images?include_image_language=ru,en,null',
                'movie/13804/images?include_image_language=ru,en,null'
            ], 'на третий фильм не ходим, раз логотип уже найден');
        });

        await test('логотип: результат запоминается, повторный ряд не ходит в сеть', async function () {
            var before = calls.tmdb.length;
            var line = newLine(L('harry-potter'));
            line.fire('create');
            await wait(20);
            assert.strictEqual(calls.tmdb.length, before, 'запросов быть не должно');
            assert.strictEqual(line.name.children[0].src, 'img:w500/hp_en.png');
        });

        await test('логотип: запросы идут с длинным нативным кешем', function () {
            var img = calls.tmdb.filter(function (c) { return /\/images\?/.test(c.path); });
            assert.ok(img.length > 0);
            img.forEach(function (c) { assert.ok(c.cache.life >= 60 * 24 * 7, c.path); });
        });

        await test('логотип: нет логотипов вообще — остаётся текст', async function () {
            imageMode = 'ok';
            var line = newLine(L('test-predator')); // для этих фильмов images в фикстурах нет -> ошибка TMDB
            line.fire('create');
            await wait(40);
            assert.strictEqual(line.name.children.length, 0);
            assert.strictEqual(line.name.innerHTML, 'Название');
        });

        await test('логотип: картинка не загрузилась — остаётся текст', async function () {
            imageMode = 'error';
            var line = newLine(L('harry-potter'));
            line.fire('create');
            await wait(30);
            imageMode = 'ok';
            assert.strictEqual(line.name.children.length, 0);
            assert.strictEqual(line.name.innerHTML, 'Название');
        });

        await test('логотип: ряд убрали до ответа TMDB — ничего не трогаем', async function () {
            // свежая коллекция: логотип ещё не в памяти, ответ придёт асинхронно
            TH.collections.add({ id: 'late-logo', title: 'late', items: [{ type: 'movie', id: 384018 }] });
            var res = await new Promise(function (r) { TH.collections.resolve('late-logo', r); });
            var line = newLine(TH.line(res));
            line.fire('create');
            line.name.parentNode = null; // как после destroy, до прихода ответа
            await wait(30);
            assert.strictEqual(line.name.children.length, 0);
            assert.strictEqual(line.name.innerHTML, 'Название');
        });

        await test('логотип: spec.logo_from имеет приоритет', async function () {
            TH.collections.add({ id: 'from', title: 'from', tmdb_collection: 9485, logo_from: { type: 'movie', id: 384018 } });
            var res = await new Promise(function (r) { TH.collections.resolve('from', r); });
            var line = newLine(TH.line(res));
            line.fire('create');
            await wait(30);
            assert.strictEqual(line.name.children[0].src, 'img:w500/hobbs_ru.png');
        });

        await test('ряд: params.emit подписывает Line на onCreate', function () {
            assert.strictEqual(typeof L('harry-potter').params.emit.onCreate, 'function');
        });

        await test('запросы идут через нативный кеш TMDB', function () {
            assert.ok(calls.tmdb.length > 0);
            calls.tmdb.forEach(function (c) { assert.ok(c.cache && c.cache.life > 0, c.path); });
        });

        await test('onInstance: Enter на карточке открывает полную карточку', function () {
            var card = newCard(L('test-predator').results[0]);
            comp.fire('instance', card, L('test-predator').results[0]);
            card.fire('enter');
            assert.deepStrictEqual(calls.routed[0], 'full');
            assert.strictEqual(calls.routed[1].id, L('test-predator').results[0].id);
        });

        await test('фон: при фокусе берётся кадр фильма (backdrop, w1280)', function () {
            var withBackdrop = L('test-predator').results[0]; // Predator 1987, есть backdrop_path
            var card = newCard(withBackdrop); comp.fire('instance', card, withBackdrop);

            calls.bg = null;
            card.fire('focus');
            assert.strictEqual(calls.bg, 'img:w1280/bd1.jpg');
        });

        await test('фон: без backdrop_path — нативная логика Lampa', function () {
            var noBackdrop = L('test-predator').results[1]; // Predator 2, кадра нет
            var card = newCard(noBackdrop); comp.fire('instance', card, noBackdrop);

            calls.bg = null;
            card.fire('focus');
            assert.strictEqual(calls.bg, 'native:' + noBackdrop.id);
        });

        await test('фон: мышь и пульт — по наведению и по фокусу', function () {
            touchDevice = false;
            var data = L('test-predator').results[0];
            var c = window.TapokHub.card(data, 'movie').params.emit;
            assert.strictEqual(typeof c.onlyFocus, 'function');
            assert.strictEqual(typeof c.onlyHover, 'function');
            assert.strictEqual(c.onlyTouch, undefined, 'по касанию фон не меняем никогда');
            var card = newCard(window.TapokHub.card(data, 'movie')); comp.fire('instance', card, data);
            calls.bg = null; card.fire('hover');
            assert.strictEqual(calls.bg, 'img:w1280/bd1.jpg');
        });

        await test('фон: на сенсорном экране только по фокусу; касание не перерисовывает фон при свайпе', function () {
            touchDevice = true;
            try {
                var data = L('test-predator').results[0];
                var c = window.TapokHub.card(data, 'movie').params.emit;
                assert.strictEqual(typeof c.onlyFocus, 'function', 'фокус остаётся (как в нативной Lampa)');
                assert.strictEqual(c.onlyHover, undefined, 'наведения на сенсорном экране нет');
                assert.strictEqual(c.onlyTouch, undefined, 'касание в начале свайпа не должно менять фон');
                var card = newCard(window.TapokHub.card(data, 'movie')); comp.fire('instance', card, data);
                calls.bg = null; card.fire('touch'); card.fire('hover');
                assert.strictEqual(calls.bg, null, 'касание и «наведение» фон не трогают');
                card.fire('focus');
                assert.strictEqual(calls.bg, 'img:w1280/bd1.jpg', 'а фокус по-прежнему меняет');
            } finally { touchDevice = false; }
        });


        await test('фон на главной: нативный onFocus main.js не перебивает наш', function () {
            var data = L('test-predator').results[0];
            var card = newCard(data);
            var nativeCalled = false;
            // то, что делает components/main.js после createInstance
            card.use({ onFocus: function () { nativeCalled = true; Lampa.Background.change('native-poster'); } });

            calls.bg = null;
            card.fire('focus');
            assert.strictEqual(nativeCalled, false, 'нативный onFocus должен быть заглушен');
            assert.strictEqual(calls.bg, 'img:w1280/bd1.jpg');
        });

        await test('TH.card копирует ответ TMDB, оригинал (кеш) не трогает', function () {
            var raw = { id: 5, name: 'X', poster_path: '/p.jpg' };
            var card = TH.card(raw, 'tv');
            assert.notStrictEqual(card, raw);
            assert.strictEqual(raw.params, undefined, 'функции не должны попасть в оригинал');
            assert.strictEqual(raw.media_type, undefined);
            assert.strictEqual(card.media_type, 'tv');
            assert.strictEqual(card.original_name, 'X');
            assert.strictEqual(typeof card.params.emit.onlyFocus, 'function');
        });

    })();

    await (async function () {
        // TMDB недоступен совсем: коллекция просто не строится (null), исключений и зависаний нет.
        var original = Lampa.Api.sources.tmdb.get;
        Lampa.Api.sources.tmdb.get = function (p, params, ok, fail) { setTimeout(fail, 1); };
        TH.collections.add({ id: 'offline', title: 'offline', items: [{ type: 'movie', id: 1 }] });

        var res = await new Promise(function (r) { TH.collections.resolve('offline', r); });

        await test('TMDB недоступен: коллекция не строится (null), без зависания', function () {
            assert.strictEqual(res, null);
        });
        Lampa.Api.sources.tmdb.get = original;
    })();

    await test('валидация add(): без id/title и без источника отклоняются', function () {
        assert.strictEqual(TH.collections.add({ title: 'x', items: [{ type: 'movie', id: 1 }] }), false);
        assert.strictEqual(TH.collections.add({ id: 'x', title: 'x' }), false);
        assert.strictEqual(TH.collections.add({ id: 'test-mixed', title: 'dup', items: [{ type: 'movie', id: 1 }] }), false);
    });

    /* ---------- наш кеширующий сервер (TH.proxy) ---------- */

    var BASE = 'https://proxy.test/tmdb/TOKEN';
    var api = function (u) { return Lampa.TMDB.api(u); };
    var image = function (u) { return Lampa.TMDB.image(u); };

    await test('прокси: пока адрес не задан, Lampa.TMDB не тронута', function () {
        assert.strictEqual(Lampa.TMDB.api, nativeApi);
        assert.strictEqual(Lampa.TMDB.image, nativeImage);
        assert.strictEqual(TH.proxy.enabled(), false);
        assert.strictEqual(api('collection/1241?x=1'), 'https://api.native/3/collection/1241?x=1');
    });

    await test('прокси: пустой и нерасшифрованный адрес сборки не включают подмену', function () {
        TH.proxy.configure('');
        assert.strictEqual(TH.proxy.enabled(), false);
        assert.strictEqual(Lampa.TMDB.api, nativeApi, 'без адреса подмены не ставим вообще');
        assert.ok(/^@@/.test(TH.proxyBase) === false || TH.proxyBase.indexOf('@@') === 0, 'в тестовой сборке адрес не подставлен');
    });

    TH.proxy.configure(BASE + '/');   // хвостовой слэш срезается
    await wait(5);

    await test('прокси: настройка ставит подмены и проверяет здоровье сервера', function () {
        assert.strictEqual(TH.proxy.base(), BASE);
        assert.strictEqual(TH.proxy.enabled(), true);
        assert.notStrictEqual(Lampa.TMDB.api, nativeApi);
        assert.notStrictEqual(Lampa.TMDB.image, nativeImage);
        assert.ok(calls.health.indexOf(BASE + '/health') > -1, 'запрошен /health');
    });

    await test('прокси API: только своё — наши коллекции и их фильмы', function () {
        var ours = BASE + '/api/https://api.themoviedb.org/3/';
        assert.strictEqual(api('collection/1241?api_key=K&language=ru'), ours + 'collection/1241?api_key=K&language=ru');
        assert.strictEqual(api('collection/9485?language=ru'), ours + 'collection/9485?language=ru');
        assert.strictEqual(api('movie/384018?language=ru'), ours + 'movie/384018?language=ru', 'спин-офф из extras');
        assert.strictEqual(api('movie/384018/images?include_image_language=ru,en,null&language=ru'), ours + 'movie/384018/images?include_image_language=ru,en,null&language=ru');
        assert.strictEqual(api('tv/1396/images?language=ru'), ours + 'tv/1396/images?language=ru', 'сериал из подборки items');
        assert.strictEqual(api('movie/384018?append_to_response=images&language=ru'), ours + 'movie/384018?append_to_response=images&language=ru', 'полная карточка нашего фильма');
    });

    await test('прокси API: чужое идёт штатным путём Lampa', function () {
        [ 'collection/5?language=ru', 'movie/424242?language=ru', 'search/movie?query=x', 'trending/all/day',
          'discover/movie?sort_by=popularity.desc', 'movie/popular', 'person/123', 'tv/999/season/1' ].forEach(function (u) {
            assert.strictEqual(api(u), 'https://api.native/3/' + u, u);
        });
    });

    await test('прокси API: фильмы коллекции TMDB становятся «своими» после получения списка частей', async function () {
        var before = api('movie/999001?language=ru');
        assert.strictEqual(before, 'https://api.native/3/movie/999001?language=ru');
        MOVIES['collection/1241'].parts.push({ id: 999001, title: 'New', release_date: '2030-01-01' });
        MOVIES['movie/999001/images?include_image_language=ru,en,null'] = { logos: [] };
        TH.collections.add({ id: 'new-hp', title: 'new', tmdb_collection: 1241 });   // тот же TMDB-id, другой набор
        await new Promise(function (r) { TH.collections.resolve('new-hp', r); });
        assert.ok(api('movie/999001/images?language=ru').indexOf(BASE) === 0, 'часть коллекции теперь своя');
    });

    await test('прокси картинки: только известные файлы, размеры любые, двойной слэш терпим', async function () {
        var ours = BASE + '/img/https://image.tmdb.org/t/p/';
        var res = await new Promise(function (r) { TH.collections.resolve('test-mixed', r); });
        var card = res.results[0];                        // Interstellar: poster_path '/a.jpg'
        assert.strictEqual(card.poster_path, '/a.jpg');
        assert.strictEqual(image('t/p/w300//a.jpg'), ours + 'w300/a.jpg');
        assert.strictEqual(image('t/p/w500/a.jpg'), ours + 'w500/a.jpg');
        assert.strictEqual(image('t/p/w1280//a.jpg'), ours + 'w1280/a.jpg', 'любой размер');
        assert.strictEqual(image('t/p/w300//random_foreign.jpg'), 'https://img.native/t/p/w300//random_foreign.jpg', 'чужое — штатно');
        assert.strictEqual(image('something/else.jpg'), 'https://img.native/something/else.jpg');
    });

    await test('прокси картинки: логотип выбирается и идёт с нашего сервера', async function () {
        TH.collections.add({ id: 'logo-src', title: 'l', items: [{ type: 'movie', id: 384018 }] });
        var res = await new Promise(function (r) { TH.collections.resolve('logo-src', r); });
        var url = await new Promise(function (r) { TH.logos.forCollection(res, r); });
        assert.strictEqual(url, 'img:w500/hobbs_ru.png');   // Api.img в заглушке не идёт через TMDB.image, проверяем регистрацию:
        assert.strictEqual(image('t/p/w500//hobbs_ru.png'), BASE + '/img/https://image.tmdb.org/t/p/w500/hobbs_ru.png');
    });

    await test('прокси: TH.tmdb.get идёт через наш сервер и результат приходит', async function () {
        var before = calls.tmdb.length;
        var got = await new Promise(function (r) { TH.tmdb.get('collection/1241', r, function () { r('FAIL'); }); });
        assert.notStrictEqual(got, 'FAIL');
        var call = calls.tmdb[before];
        assert.ok(call.url.indexOf(BASE + '/api/https://api.themoviedb.org/3/collection/1241?') === 0, call.url);
        assert.ok(call.cache && call.cache.life > 0, 'нативный кеш запросов сохранён');
    });

    await test('прокси: чужой запрос TH.tmdb.get не трогает наш сервер', async function () {
        var before = calls.tmdb.length;
        await new Promise(function (r) { TH.tmdb.get('movie/424242', r, r); });
        assert.strictEqual(calls.tmdb[before].url.indexOf('https://api.native/'), 0);
    });

    await test('прокси: ошибка при живом сервере (например 404) не запускает повтор', async function () {
        healthMode = 'ok';
        var before = calls.tmdb.length;
        var failed = await new Promise(function (r) { TH.tmdb.get('collection/1241', function () { r(false); }, function () { r(true); }); });
        // ответ есть в MOVIES, поэтому симулируем ошибку принудительно
        failUrlContains = BASE;
        before = calls.tmdb.length;
        failed = await new Promise(function (r) { TH.tmdb.get('collection/1241', function () { r(false); }, function () { r(true); }); });
        failUrlContains = null;
        assert.strictEqual(failed, true);
        assert.strictEqual(calls.tmdb.length - before, 1, 'повторного запроса быть не должно');
        assert.strictEqual(TH.proxy.enabled(), true);
    });

    await test('прокси: наш сервер лежит — запрос повторяется штатным путём и подмены отключаются', async function () {
        healthMode = 'down';
        failUrlContains = BASE;   // всё, что идёт к нам, падает
        var before = calls.tmdb.length;
        var got = await new Promise(function (r) { TH.tmdb.get('collection/1241', r, function () { r('FAIL'); }); });
        failUrlContains = null;
        assert.notStrictEqual(got, 'FAIL', 'данные должны прийти штатным путём');
        var urls = calls.tmdb.slice(before).map(function (c) { return c.url; });
        assert.strictEqual(urls.length, 2);
        assert.ok(urls[0].indexOf(BASE) === 0, 'сначала наш сервер');
        assert.ok(urls[1].indexOf('https://api.native/') === 0, 'затем штатный путь');
        assert.strictEqual(TH.proxy.enabled(), false, 'до восстановления подмены выключены');
        assert.strictEqual(api('collection/1241?x=1'), 'https://api.native/3/collection/1241?x=1');
        assert.strictEqual(image('t/p/w300//a.jpg').indexOf('https://img.native/'), 0, 'картинки тоже штатно');
    });

    await test('прокси: после восстановления сервера подмены включаются снова', async function () {
        healthMode = 'ok';
        var alive = await new Promise(function (r) { TH.proxy.check(r); });
        assert.strictEqual(alive, true);
        assert.strictEqual(TH.proxy.enabled(), true);
        assert.ok(api('collection/1241?x=1').indexOf(BASE) === 0);
    });

    await test('прокси: молчание сервера дольше окна тоже сбрасывает отключение', async function () {
        healthMode = 'down';
        await new Promise(function (r) { TH.proxy.check(r); });
        assert.strictEqual(TH.proxy.enabled(), false);
        var realNow = Date.now;
        Date.now = function () { return realNow() + 6 * 60 * 1000; };   // прошло больше 5 минут
        try { assert.strictEqual(TH.proxy.enabled(), true, 'после окна снова пробуем наш сервер'); } finally { Date.now = realNow; }
        healthMode = 'ok';
    });

    await test('прокси: configure с пустым адресом выключает подмены', function () {
        TH.proxy.configure('');
        assert.strictEqual(TH.proxy.enabled(), false);
        assert.strictEqual(api('collection/1241?x=1'), 'https://api.native/3/collection/1241?x=1');
    });

    /* ---------- библиотека: кнопки на карточке фильма и клиент API ---------- */

    var LB = 'https://proxy.test/tmdb/TOKEN';
    var libCalls = [];
    var respond = function () { return [null, {}]; };
    TH.lib.transport = function (method, url, body, done) {
        libCalls.push({ method: method, url: url, body: body });
        var r = respond(method, url, body);
        if (!r) return;                       // сервер молчит: ответа не будет
        setTimeout(function () { done(r[0], r[1]); }, 1);
    };
    TH.lib.pollEvery = 5;

    var summary = function (o) { return Object.assign({ id: 7, title: 'Сага', status: 'ready', busy: false, error: null, counts: { visible: 11, hidden: 5, new: 0 } }, o || {}); };
    var flow = function (map) {   // ответы по «методу путь»
        respond = function (method, url, body) {
            var path = url.replace(LB + '/lib/', '');
            var f = map[method + ' ' + path] || map[method + ' *'];
            if (typeof f === 'function') return f(body, path);
            return f || [null, {}];
        };
    };

    // Фальшивый jQuery-контейнер страницы: ряд кнопок с «Закладками».
    var buildPage = function (withBook) {
        var container = makeEl('div'), order = [];
        container.items = order;
        var book = { node: 'book' };
        if (withBook !== false) order.push('book');
        container.length = 1;
        container.find = function (sel) {
            if (sel === '.button--book') return { length: withBook === false ? 0 : 1, after: function (n) { order.splice(order.indexOf('book') + 1, 0, n); } };
            if (sel === '.button--tapokhub-lib') {
                var libs = order.filter(function (n) { return n && n.className && n.className.indexOf('button--tapokhub-lib') > -1; });
                return { length: libs.length, after: function (n) { order.splice(order.indexOf(libs[0]) + 1, 0, n); } };
            }
            return { length: 0 };
        };
        container.append = function (n) { order.push(n); };
        var body = { find: function (sel) { return sel === '.full-start-new__buttons' ? container : { length: 0 }; } };
        return { body: body, container: container, order: order };
    };
    var btns = function (page) { return page.order.filter(function (n) { return typeof n === 'object'; }); };
    var event = function (page, kind, id) { return { type: 'complite', body: page.body, object: { method: kind, id: id } }; };
    var openPage = async function (kind, id, withBook) { var p = buildPage(withBook); TH.lib.attach(event(p, kind, id)); await wait(15); return p; };
    var text = function (n) { return n.children[n.children.length - 1].textContent; };
    var has = function (n, cls) { return (' ' + n.className + ' ').indexOf(' ' + cls + ' ') > -1; };

    TH.proxy.configure(LB);
    await wait(5);

    await test('библиотека: без адреса сервера кнопок нет', async function () {
        TH.proxy.configure('');
        var p = buildPage(); TH.lib.attach(event(p, 'movie', 11));
        assert.deepStrictEqual(p.order, ['book'], 'страница осталась как была');
        assert.strictEqual(TH.lib.enabled(), false);
        var got = null; TH.lib.status('movie', 11, function (err) { got = err; });
        assert.strictEqual(got.message, 'disabled', 'запрос без адреса не уходит в сеть');
        TH.proxy.configure(LB); await wait(5);
    });

    await test('библиотека: клиент строит адреса и тела запросов', function () {
        assert.strictEqual(TH.lib.url('items'), LB + '/lib/items');
        libCalls.length = 0; flow({});
        TH.lib.status('tv', 82856, function () {}); TH.lib.addItem('movie', 11, function () {}); TH.lib.removeItem('movie', 11, function () {});
        TH.lib.createFranchise('movie', 11, function () {}); TH.lib.choose(7, 'Q2', 'P8345', function () {}); TH.lib.franchise(7, true, function () {});
        assert.deepStrictEqual(libCalls.map(function (c) { return [c.method, c.url.replace(LB + '/lib/', ''), c.body]; }), [
            ['GET', 'status?kind=tv&id=82856', null], ['POST', 'items/add', { kind: 'movie', id: 11 }], ['POST', 'items/remove', { kind: 'movie', id: 11 }],
            ['POST', 'franchises', { kind: 'movie', id: 11 }], ['POST', 'franchises/7/choose', { wikidata: 'Q2', prop: 'P8345' }], ['GET', 'franchises/7?hidden=1', null]]);
    });

    await test('библиотека: подписка на страницу фильма реагирует только на complite', function () {
        TH.lib.install();
        assert.ok(fullHandlers.length >= 1);
        var p = buildPage(); flow({ 'GET *': [null, { in_library: false, franchise: null }] });
        fullHandlers.forEach(function (h) { h({ type: 'start', body: p.body, object: { method: 'movie', id: 11 } }); });
        assert.deepStrictEqual(p.order, ['book'], 'событие start ничего не добавляет');
    });

    await test('кнопки: две штуки сразу после «Закладок», до ответа сервера приглушены', async function () {
        flow({ 'GET *': [null, { in_library: false, franchise: null }] });
        var p = buildPage(); TH.lib.attach(event(p, 'movie', 11));
        var b = btns(p);
        assert.strictEqual(p.order[0], 'book');
        assert.strictEqual(b.length, 2);
        assert.ok(has(b[0], 'button--tapokhub-lib') && has(b[1], 'button--tapokhub-col'), 'порядок: библиотека, затем коллекция');
        assert.ok(has(b[0], 'selector') && has(b[0], 'full-start__button'), 'обычные кнопки Lampa: попадают в навигацию');
        assert.ok(has(b[0], 'is-busy') && has(b[1], 'is-busy'), 'пока статус не пришёл — приглушены');
        assert.ok(b[0].innerHTML.indexOf('<svg') === 0 && b[0].innerHTML.indexOf('stroke="currentColor"') > -1, 'иконка рисуется цветом текста');
        await wait(15);
        assert.ok(!has(b[0], 'is-busy') && !has(b[1], 'is-busy'));
        assert.deepStrictEqual([text(b[0]), text(b[1])], ['В библиотеку', 'Создать коллекцию']);
    });

    await test('кнопки: английский интерфейс (TH.i18n.force), после возврата на русский подписи снова русские', async function () {
        TH.i18n.force('en');
        try {
            flow({ 'GET *': [null, { in_library: false, franchise: null }] });
            var p = buildPage(); TH.lib.attach(event(p, 'movie', 11));
            await wait(15);
            var b = btns(p);
            assert.deepStrictEqual([text(b[0]), text(b[1])], ['Add to library', 'Create collection']);
        } finally { TH.i18n.force(''); }
        var p2 = buildPage(); TH.lib.attach(event(p2, 'movie', 11));
        await wait(15);
        assert.deepStrictEqual([text(btns(p2)[0]), text(btns(p2)[1])], ['В библиотеку', 'Создать коллекцию']);
    });

    await test('кнопки: нет «Закладок» — добавляются в конец ряда', async function () {
        flow({ 'GET *': [null, { in_library: false, franchise: null }] });
        var p = await openPage('movie', 11, false);
        assert.strictEqual(btns(p).length, 2);
        assert.ok(has(p.order[0], 'button--tapokhub-lib') && has(p.order[1], 'button--tapokhub-col'));
    });

    await test('кнопки: повторное событие для той же страницы не удваивает кнопки', async function () {
        flow({ 'GET *': [null, { in_library: false, franchise: null }] });
        var p = await openPage('movie', 11);
        TH.lib.attach(event(p, 'movie', 11));
        assert.strictEqual(btns(p).length, 2);
    });

    await test('кнопки: вид позиции берётся со страницы (tv, запасной id из card, нет id — нет кнопок)', async function () {
        libCalls.length = 0; flow({ 'GET *': [null, { in_library: false, franchise: null }] });
        await openPage('tv', 82856);
        assert.ok(libCalls[0].url.indexOf('status?kind=tv&id=82856') > -1);
        var p = buildPage(); TH.lib.attach({ type: 'complite', body: p.body, object: { method: 'movie', card: { id: 603 } } }); await wait(10);
        assert.ok(libCalls[libCalls.length - 1].url.indexOf('id=603') > -1);
        var q = buildPage(); TH.lib.attach({ type: 'complite', body: q.body, object: { method: 'movie' } });
        assert.deepStrictEqual(q.order, ['book']);
    });

    await test('кнопка «В библиотеку»: состояние «уже в библиотеке» подсвечено', async function () {
        flow({ 'GET *': [null, { in_library: true, franchise: null }] });
        var b = btns(await openPage('movie', 11));
        assert.strictEqual(text(b[0]), 'В библиотеке');
        assert.ok(has(b[0], 'is-active'));
    });

    await test('кнопка «В библиотеку»: добавить и убрать, сообщения и состояние', async function () {
        var inLib = false; libCalls.length = 0; calls.noty = [];
        flow({ 'GET *': function () { return [null, { in_library: inLib, franchise: null }]; },
               'POST items/add': function () { inLib = true; return [null, { in_library: true, franchise: null }]; },
               'POST items/remove': function () { inLib = false; return [null, { in_library: false, franchise: null }]; } });
        var b = btns(await openPage('movie', 11));
        b[0].fire('hover:enter'); await wait(15);
        assert.strictEqual(text(b[0]), 'В библиотеке'); assert.ok(has(b[0], 'is-active'));
        assert.ok(calls.noty.indexOf('Добавлено в библиотеку') > -1);
        b[0].fire('hover:enter'); await wait(15);
        assert.strictEqual(text(b[0]), 'В библиотеку'); assert.ok(!has(b[0], 'is-active'));
        assert.ok(calls.noty.indexOf('Убрано из библиотеки') > -1);
        assert.deepStrictEqual(libCalls.filter(function (c) { return c.method === 'POST'; }).map(function (c) { return c.url.replace(LB + '/lib/', ''); }), ['items/add', 'items/remove']);
    });

    await test('кнопка «В библиотеку»: ошибки не ломают состояние', async function () {
        calls.noty = [];
        var mode = 'net';
        flow({ 'GET *': [null, { in_library: false, franchise: null }], 'POST items/add': function () { return mode === 'net' ? [{ status: 0 }, null] : [{ status: 404 }, null]; } });
        var b = btns(await openPage('movie', 11));
        b[0].fire('hover:enter'); await wait(15);
        assert.strictEqual(text(b[0]), 'В библиотеку'); assert.ok(!has(b[0], 'is-busy'), 'после ошибки снова доступна');
        assert.strictEqual(calls.noty[calls.noty.length - 1], 'Не удалось изменить библиотеку');
        mode = '404'; b[0].fire('hover:enter'); await wait(15);
        assert.strictEqual(calls.noty[calls.noty.length - 1], 'Позиции нет в TMDB');
    });

    await test('кнопки: во время запроса повторное нажатие не шлёт второй запрос', async function () {
        libCalls.length = 0;
        flow({ 'GET *': [null, { in_library: false, franchise: null }], 'POST items/add': [null, { in_library: true, franchise: null }] });
        var b = btns(await openPage('movie', 11));
        b[0].fire('hover:enter'); b[0].fire('hover:enter'); b[0].fire('hover:enter'); await wait(15);
        assert.strictEqual(libCalls.filter(function (c) { return c.method === 'POST'; }).length, 1);
    });

    await test('кнопки: сервер недоступен при открытии — понятные подписи, нажатие повторяет запрос', async function () {
        var down = true; libCalls.length = 0;
        flow({ 'GET *': function () { return down ? [{ status: 0 }, null] : [null, { in_library: false, franchise: null }]; } });
        var b = btns(await openPage('movie', 11));
        assert.deepStrictEqual([text(b[0]), text(b[1])], ['Библиотека недоступна', 'Коллекция недоступна']);
        var before = libCalls.length; down = false;
        b[0].fire('hover:enter'); await wait(15);
        assert.ok(libCalls.length > before, 'нажатие повторяет запрос статуса');
        assert.deepStrictEqual([text(b[0]), text(b[1])], ['В библиотеку', 'Создать коллекцию'], 'после восстановления кнопки рабочие');
        assert.strictEqual(libCalls.filter(function (c) { return c.method === 'POST'; }).length, 0, 'а сама позиция при этом не добавлялась');
    });

    await test('кнопка «Коллекция»: создание, ход сборки и готовность', async function () {
        calls.noty = []; libCalls.length = 0; var polls = 0;
        flow({
            'GET *': function () { polls++; return [null, { in_library: false, franchise: polls < 3 ? summary({ status: polls === 1 ? 'pending' : 'resolving', counts: { visible: 0, hidden: 0, new: 0 } }) : (polls === 0 ? null : summary()) }]; },
            'POST franchises': [null, summary({ status: 'pending', counts: { visible: 0, hidden: 0, new: 0 } })]
        });
        polls = -1; // первый статус при открытии: коллекции нет
        var first = true;
        flow({
            'GET *': function () { if (first) { first = false; return [null, { in_library: false, franchise: null }]; } polls++; return [null, { in_library: false, franchise: polls < 2 ? summary({ status: 'resolving' }) : summary() }]; },
            'POST franchises': [null, summary({ status: 'pending' })]
        });
        polls = 0;
        var b = btns(await openPage('movie', 11));
        assert.strictEqual(text(b[1]), 'Создать коллекцию');
        b[1].fire('hover:enter'); await wait(8);
        assert.strictEqual(text(b[1]), 'Собираю коллекцию…'); assert.ok(has(b[1], 'is-busy'));
        assert.ok(calls.noty.indexOf('Собираю коллекцию, это займёт до минуты…') > -1);
        await wait(120);
        assert.strictEqual(text(b[1]), 'Коллекция'); assert.ok(has(b[1], 'is-active') && !has(b[1], 'is-busy'));
        assert.ok(calls.noty.indexOf('Коллекция «Сага» готова: 11 позиций') > -1);
        assert.strictEqual(libCalls.filter(function (c) { return c.url.indexOf('franchises') > -1 && c.method === 'POST'; }).length, 1, 'создание отправлено один раз');
    });

    await test('склонение «позиций» в сообщении о готовности', function () {
        var f = function (n) { return n + ' ' + TH.lib.plural(n, ['позиция', 'позиции', 'позиций']); };
        assert.deepStrictEqual([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 34, 101, 111].map(f), [
            '0 позиций', '1 позиция', '2 позиции', '4 позиции', '5 позиций', '11 позиций', '12 позиций', '14 позиций',
            '21 позиция', '22 позиции', '25 позиций', '34 позиции', '101 позиция', '111 позиций']);
    });

    await test('кнопка «Коллекция»: пока идёт сборка, нажатие ничего не создаёт заново', async function () {
        calls.noty = []; libCalls.length = 0;
        flow({ 'GET *': [null, { in_library: false, franchise: summary({ status: 'resolving' }) }] });
        var b = btns(await openPage('movie', 11));
        assert.strictEqual(text(b[1]), 'Собираю коллекцию…', 'открыли страницу, пока идёт сборка: опрос подхватывается');
        b[1].fire('hover:enter'); await wait(10);
        assert.ok(calls.noty.indexOf('Коллекция ещё собирается…') > -1);
        assert.strictEqual(libCalls.filter(function (c) { return c.method === 'POST'; }).length, 0);
    });

    await test('кнопка «Коллекция»: готовая открывает экран франшизы без лишних запросов', async function () {
        libCalls.length = 0; calls.activity.length = 0;
        flow({ 'GET *': [null, { in_library: false, franchise: summary({ id: 42, title: 'Звёздные войны' }) }] });
        var b = btns(await openPage('tv', 82856));
        assert.strictEqual(text(b[1]), 'Коллекция'); assert.ok(has(b[1], 'is-active'));
        b[1].fire('hover:enter'); await wait(5);
        var a = calls.activity[calls.activity.length - 1];
        assert.deepStrictEqual([a.component, a.franchise_id, a.title], ['tapokhub_franchise', 42, 'Звёздные войны']);
        assert.strictEqual(libCalls.filter(function (c) { return c.method === 'POST'; }).length, 0);
    });

    await test('кнопка «Коллекция»: сразу готовая после создания (франшиза уже есть) открывается', async function () {
        calls.activity.length = 0;
        flow({ 'GET *': [null, { in_library: false, franchise: null }], 'POST franchises': [null, summary({ id: 9 })] });
        var b = btns(await openPage('movie', 11));
        b[1].fire('hover:enter'); await wait(15);
        assert.strictEqual(calls.activity[calls.activity.length - 1].franchise_id, 9);
    });

    await test('кнопка «Коллекция»: у позиции несколько франшиз — окно выбора, затем сборка выбранной', async function () {
        calls.select = null; calls.toggled = []; libCalls.length = 0; var chosen = false;
        var choices = [{ wikidata: 'Q1', prop: 'P8345', title: 'Сага' }, { wikidata: 'Q2', prop: 'P8345', title: 'Другая сага' }];
        flow({
            'GET *': function () { return [null, { in_library: false, franchise: chosen ? summary({ status: 'ready' }) : summary({ status: 'needs_choice', choices: choices }) }]; },
            'POST franchises/7/choose': function () { chosen = true; return [null, summary({ status: 'pending' })]; }
        });
        var b = btns(await openPage('movie', 4000));
        assert.strictEqual(text(b[1]), 'Выбрать франшизу');
        b[1].fire('hover:enter'); await wait(5);
        assert.ok(calls.select, 'открыто окно выбора Lampa');
        assert.deepStrictEqual(calls.select.items.map(function (i) { return i.title; }), ['Сага', 'Другая сага']);
        calls.select.onSelect(calls.select.items[1]); await wait(15);
        assert.strictEqual(calls.toggled[calls.toggled.length - 1], 'full_start', 'фокус возвращён на страницу');
        var c = libCalls.filter(function (x) { return x.url.indexOf('/choose') > -1; })[0];
        assert.deepStrictEqual(c.body, { wikidata: 'Q2', prop: 'P8345' });
        await wait(80);
        assert.strictEqual(text(b[1]), 'Коллекция');
    });

    await test('кнопка «Коллекция»: выбор отменён — фокус возвращается, ничего не отправлено', async function () {
        calls.select = null; calls.toggled = []; libCalls.length = 0;
        flow({ 'GET *': [null, { in_library: false, franchise: summary({ status: 'needs_choice', choices: [{ wikidata: 'Q1', prop: 'P8345', title: 'Сага' }] }) }] });
        var b = btns(await openPage('movie', 4000));
        b[1].fire('hover:enter'); await wait(5);
        calls.select.onBack();
        assert.strictEqual(calls.toggled[calls.toggled.length - 1], 'full_start');
        assert.strictEqual(libCalls.filter(function (c) { return c.method === 'POST'; }).length, 0);
    });

    await test('кнопка «Коллекция»: ошибка сборки — «Повторить», нажатие создаёт заново', async function () {
        libCalls.length = 0; var recreated = false;
        flow({ 'GET *': function () { return [null, { in_library: false, franchise: recreated ? summary({ status: 'resolving' }) : summary({ status: 'error', error: 'нет данных' }) }]; },
               'POST franchises': function () { recreated = true; return [null, summary({ status: 'pending' })]; } });
        var b = btns(await openPage('movie', 11));
        assert.strictEqual(text(b[1]), 'Повторить сбор');
        b[1].fire('hover:enter'); await wait(8);
        assert.strictEqual(libCalls.filter(function (c) { return c.method === 'POST' && c.url.slice(-11) === '/franchises'; }).length, 1);
        assert.strictEqual(text(b[1]), 'Собираю коллекцию…');
    });

    await test('кнопка «Коллекция»: сборка закончилась ошибкой — сообщение с причиной', async function () {
        calls.noty = []; var n = 0;
        flow({ 'GET *': function () { n++; return [null, { in_library: false, franchise: n === 1 ? null : summary({ status: 'error', error: 'Wikidata недоступна' }) }]; }, 'POST franchises': [null, summary({ status: 'pending' })] });
        var b = btns(await openPage('movie', 11));
        b[1].fire('hover:enter'); await wait(60);
        assert.ok(calls.noty.indexOf('Не удалось собрать коллекцию: Wikidata недоступна') > -1);
        assert.strictEqual(text(b[1]), 'Повторить сбор');
    });

    await test('кнопка «Коллекция»: ошибка создания и моргнувшая сеть при опросе', async function () {
        calls.noty = []; var n = 0, failCreate = true;
        flow({ 'GET *': function () { n++; return n === 1 ? [null, { in_library: false, franchise: null }] : (n === 3 ? [{ status: 0 }, null] : [null, { in_library: false, franchise: summary({ status: n < 5 ? 'resolving' : 'ready' }) }]); },
               'POST franchises': function () { return failCreate ? [{ status: 0 }, null] : [null, summary({ status: 'pending' })]; } });
        var b = btns(await openPage('movie', 11));
        b[1].fire('hover:enter'); await wait(15);
        assert.strictEqual(calls.noty[calls.noty.length - 1], 'Не удалось создать коллекцию');
        assert.strictEqual(text(b[1]), 'Создать коллекцию'); assert.ok(!has(b[1], 'is-busy'));
        failCreate = false; b[1].fire('hover:enter'); await wait(150);
        assert.strictEqual(text(b[1]), 'Коллекция', 'ошибка одного опроса не обрывает ожидание');
    });

    await test('кнопки: страницу закрыли — опрос сборки прекращается', async function () {
        libCalls.length = 0;
        flow({ 'GET *': [null, { in_library: false, franchise: summary({ status: 'resolving' }) }] });
        await openPage('movie', 11);
        var before = libCalls.length;
        attached = false;                    // страница ушла из документа
        await wait(60);
        attached = true;
        assert.ok(libCalls.length - before <= 1, 'после закрытия страницы запросы прекращаются');
        var after = libCalls.length; await wait(40);
        assert.strictEqual(libCalls.length, after);
    });

    /* ---------- экран коллекции-франшизы ---------- */

    var franchiseDetail = function () {
        return { id: 7, title: 'Сага', status: 'ready', groups: [
            { key: 'collection:500', title: 'Сага', items: [{ id: 1000, media_type: 'movie', title: 'Часть 1', release_date: '2001-05-01', poster_path: '/p1.jpg', backdrop_path: '/b1.jpg', is_new: false, hidden: false }, { id: 1001, media_type: 'movie', title: 'Часть 2', release_date: '2003-05-01', poster_path: '/p2.jpg', backdrop_path: null }] },
            { key: 'series', title: 'Сериалы', items: [{ id: 3000, media_type: 'tv', name: 'Сериал', first_air_date: '2019-11-12', poster_path: '/p3.jpg', backdrop_path: null }] }] };
    };

    await test('экран франшизы: на весь экран сеткой, шапка с названием, группы с заголовками', async function () {
        libCalls.length = 0;
        flow({ 'GET franchises/7': [null, franchiseDetail()] });
        var screen = calls.components.tapokhub_franchise({ franchise_id: 7 });
                screen.fire('create'); await wait(15);
        assert.ok(screen.built, 'build вызван');
        assert.strictEqual(screen.built.total_pages, 1, 'страниц нет: подгружать нечего');
        assert.deepStrictEqual(screen.built.results.map(function (c) { return c.id; }), [900000100, 1000, 1001, 3000], 'плитка «Настроить», затем все карточки одной сеткой по порядку групп');
        var s = screen.sections();
        assert.deepStrictEqual(s.map(function (x) { return x.title; }), ['', 'Сага', 'Сериалы']);
        assert.deepStrictEqual(s.map(function (x) { return x.cards.length; }), [1, 2, 1]);
        assert.deepStrictEqual(s[0].hero, { title: 'Сага', logo: null }, 'шапка над плиткой «Настроить»; логотипа у франшизы нет — название текстом');
        assert.strictEqual(s[1].hero, undefined);
        var card = s[2].cards[0];
        assert.strictEqual(card.media_type, 'tv'); assert.strictEqual(card.original_name, 'Сериал', 'TH.card довёл карточку сериала');
        assert.strictEqual(typeof card.params.emit.onlyFocus, 'function', 'фон по фокусу, как у остальных карточек');
        assert.strictEqual(libCalls[0].url.replace(LB + '/lib/', ''), 'franchises/7', 'обычный режим: скрытое не запрашиваем');
    });

    await test('сетка: 6 колонок, вертикальная прокрутка нативной Category', function () {
        var o = { franchise_id: 7 };
        calls.components.tapokhub_franchise(o);
        assert.deepStrictEqual(o.params.items, { mapping: 'grid', cols: 6, limit_view: 6, limit_collection: 60 });
    });

    await test('экран франшизы: у франшизы есть логотип — в шапке картинка вместо названия', async function () {
        flow({ 'GET franchises/7': [null, Object.assign(franchiseDetail(), { logo: '/saga_logo.png' })] });
        var screen = calls.components.tapokhub_franchise({ franchise_id: 7 });
        screen.fire('create'); await wait(15);
        var hero = screen.sections()[0].hero;
        assert.strictEqual(hero.title, 'Сага');
        await wait(30);
        var el = screen.parent.children.filter(function (e) { return /--big/.test(e.className || ''); })[0];
        assert.strictEqual(el.children[0].children[0].src, 'img:w500/saga_logo.png', 'после загрузки название заменено картинкой');
    });

    await test('экран франшизы: карточка открывает страницу фильма, пустой ответ и ошибка дают пустой экран', async function () {
        flow({ 'GET franchises/7': [null, franchiseDetail()] });
        var screen = calls.components.tapokhub_franchise({ franchise_id: 7 });
        screen.fire('create'); await wait(15);
        var card = newCard(screen.built.results[1]); screen.fire('instance', card, screen.built.results[1]);
        card.fire('enter');
        assert.deepStrictEqual([calls.routed[0], calls.routed[1].id], ['full', 1000]);

        flow({ 'GET franchises/7': [null, { id: 7, groups: [] }] });
        var empty = calls.components.tapokhub_franchise({ franchise_id: 7 }); empty.fire('create'); await wait(15);
        assert.ok(empty.emptied && !empty.built);
        flow({ 'GET franchises/7': [{ status: 404 }, null] });
        var broken = calls.components.tapokhub_franchise({ franchise_id: 7 }); broken.fire('create'); await wait(15);
        assert.ok(broken.emptied);
    });

    /* ---------- режим «Настроить» ---------- */

    var settingsDetail = function () {
        var d = franchiseDetail();
        d.groups[0].items[1].hidden = true; d.groups[0].items[1].hidden_by = 'auto';
        d.groups[0].hidden_count = 1;
        d.groups.push({ key: 'other', title: 'Прочее', hidden_count: 1, items: [{ id: 5000, media_type: 'movie', title: 'Короткий ролик', release_date: '2010-01-01', poster_path: '/s.jpg', hidden: true, hidden_by: 'auto', source: 'wikidata' },
            { id: 5001, media_type: 'movie', title: 'Моё добавление', release_date: '2012-01-01', poster_path: '/m.jpg', hidden: false, source: 'manual' }] });
        return d;
    };
    var jq = function () {   // карточка Lampa: DOM-элемент, find() отдаёт один элемент или null, есть addClass/toggleClass
        var view = makeEl('div');
        var h = { classes: {}, view: view, badges: function () { return view.children.map(function (k) { return k.textContent; }); },
            find: function (sel) {
                if (sel === '.card__view') return view;
                if (sel === '.tapokhub-badge') return view.children.filter(function (k) { return /tapokhub-badge/.test(k.className); })[0] || null;
                return null;
            },
            addClass: function (c) { this.classes[c] = true; return this; }, toggleClass: function (c, on) { if (on) this.classes[c] = true; else delete this.classes[c]; return this; } };
        return h;
    };
    var openSettings = async function (id) {
        flow({ 'GET franchises/7?hidden=1': [null, settingsDetail()] });
        var s = calls.components.tapokhub_franchise({ franchise_id: 7, settings: true });
        s.fire('create'); await wait(15);
        return s;
    };

    await test('«Настроить»: обычный экран показывает плитку, она включает режим настройки (замена экрана, а не новый в стеке)', async function () {
        flow({ 'GET franchises/7': [null, franchiseDetail()] });
        var screen = calls.components.tapokhub_franchise({ franchise_id: 7 }); screen.fire('create'); await wait(15);
        var tile = screen.built.results[0];
        assert.strictEqual(tile.title, 'Настроить');
        calls.replaced = [];
        tile.params.emit.onlyEnter();
        assert.deepStrictEqual(calls.replaced, [{ settings: true }]);
    });

    await test('экран франшизы: стартовый фокус на первой карточке фильма, а не на кнопке «Настроить»', async function () {
        flow({ 'GET franchises/7': [null, franchiseDetail()] });
        var screen = calls.components.tapokhub_franchise({ franchise_id: 7 }); screen.fire('create'); await wait(15);
        assert.strictEqual(screen.last, screen.items[1].render(true), 'last указывает на «Часть 1», а не на плитку-кнопку');
        assert.strictEqual(screen.last.data.id, 1000);
        flow({ 'GET franchises/7?hidden=1': [null, franchiseDetail()] });
        var editing = calls.components.tapokhub_franchise({ franchise_id: 7, settings: true }); editing.fire('create'); await wait(15);
        assert.strictEqual(editing.last.data.id, 1000, 'в режиме настройки тоже: четыре кнопки пропускаются');
        var empty = calls.components.tapokhub_franchise({ franchise_id: 7 }); flow({ 'GET franchises/7': [{ status: 500 }, null] }); empty.fire('create'); await wait(15);
        assert.ok(!empty.last, 'без карточек фокус не трогаем');
    });
    await test('«Настроить»: значок — шестерёнка (зубчатое колесо со ступицей)', async function () {
        flow({ 'GET franchises/7': [null, franchiseDetail()] });
        var screen = calls.components.tapokhub_franchise({ franchise_id: 7 }); screen.fire('create'); await wait(15);
        var html = jq();
        screen.built.results[0].params.emit.onCreate.call({ html: html });
        var svg = html.view.children[0].innerHTML;
        assert.ok(/<circle cx="12" cy="12" r="3"\/>/.test(svg) && /<path d="M12\.2 2h/.test(svg), 'контур зубчатого колеса и круг в центре');
    });
    await test('«Настроить»: плитка-кнопка рисует значок внутри карточки и не роняет создание карточки', async function () {
        flow({ 'GET franchises/7': [null, franchiseDetail()] });
        var screen = calls.components.tapokhub_franchise({ franchise_id: 7 }); screen.fire('create'); await wait(15);
        var html = jq();
        screen.built.results[0].params.emit.onCreate.call({ html: html });
        assert.ok(html.classes['tapokhub-action']);
        assert.strictEqual(html.view.children.length, 1);
        assert.strictEqual(html.view.children[0].className, 'tapokhub-action__body');
        assert.ok(/<svg viewBox="0 0 24 24">/.test(html.view.children[0].innerHTML), 'значок');
        screen.built.results[0].params.emit.onCreate.call({});   // карточка без html не должна падать
    });

    await test('«Настроить»: режим настройки запрашивает и скрытое, показывает «Прочее», четыре кнопки сверху', async function () {
        libCalls.length = 0;
        var s = await openSettings();
        assert.ok(/franchises\/7\?hidden=1$/.test(libCalls[0].url), 'с параметром hidden=1');
        var g = s.sections();
        assert.deepStrictEqual(g[0].cards.map(function (c) { return c.title; }), ['Готово', 'Добавить фильм или сериал', 'Обновить состав', 'Удалить коллекцию']);
        assert.ok(/^Настройка:/.test(g[0].title), 'подсказка, как пользоваться');
        assert.deepStrictEqual(g.slice(1).map(function (x) { return x.title; }), ['Сага · скрыто: 1', 'Сериалы', 'Прочее · скрыто: 1'], 'число скрытого в заголовке группы');
        assert.deepStrictEqual(g[1].cards.map(function (c) { return c.id; }), [1000, 1001], 'скрытые показаны вместе с остальными');
    });

    await test('«Настроить»: карточка по Enter скрывается и возвращается, метки меняются, на страницу фильма не уходит', async function () {
        var s = await openSettings();
        var cards = s.sections()[1].cards;
        var visible = cards[0], hidden = cards[1];
        var routedBefore = calls.routed && calls.routed.length;
        var html = jq();
        visible.params.emit.onCreate.call({ html: html });
        assert.ok(!html.classes['tapokhub-off'] && html.badges().length === 0, 'видимая: без метки');
        var hHtml = jq();
        hidden.params.emit.onCreate.call({ html: hHtml });
        assert.ok(hHtml.classes['tapokhub-off'] && /СКРЫТО/.test(hHtml.badges()[0]), 'скрытая: приглушена и подписана');

        var posted = [];
        flow({ 'POST franchises/7/hide': function (body) { posted.push(body); return [null, {}]; } });
        visible.params.emit.onlyEnter(); await wait(10);
        assert.deepStrictEqual(posted[0], { kind: 'movie', id: 1000, hidden: true });
        assert.ok(html.classes['tapokhub-off'] && /СКРЫТО/.test(html.badges()[0]) && html.badges().length === 1, 'после ответа сервера скрыта');
        visible.params.emit.onlyEnter(); await wait(10);
        assert.deepStrictEqual(posted[1], { kind: 'movie', id: 1000, hidden: false });
        assert.ok(!html.classes['tapokhub-off'], 'и снова видна');
        assert.strictEqual(calls.routed && calls.routed.length, routedBefore, 'Enter в настройке не открывает фильм');
    });

    await test('коллекция: долгое нажатие на карточку добавляет «Убрать из коллекции»; убранное уходит на сервер и экран перечитывается', async function () {
        flow({ 'GET franchises/7': [null, franchiseDetail()] });
        var screen = calls.components.tapokhub_franchise({ franchise_id: 7 }); screen.fire('create'); await wait(15);
        var card = screen.built.results[1];
        assert.strictEqual(typeof card.params.emit.onMenu, 'function');
        assert.strictEqual(typeof card.params.emit.onlyEnter, 'function', 'Enter по-прежнему открывает фильм');
        var menu = [{ title: 'Избранное' }];
        card.params.emit.onMenu(menu);
        assert.deepStrictEqual(menu.map(function (m) { return m.title; }), ['Избранное', 'TapokHub', 'Убрать из коллекции'], 'пункт добавлен к штатным, под разделителем');
        assert.ok(menu[1].separator);
        var posted = []; calls.replaced = []; calls.noty = [];
        flow({ 'POST franchises/7/hide': function (body) { posted.push(body); return [null, {}]; } });
        menu[2].onSelect(); await wait(10);
        assert.deepStrictEqual(posted, [{ kind: 'movie', id: 1000, hidden: true }]);
        assert.deepStrictEqual(calls.replaced, [{}], 'состав перечитан');
        assert.ok(/Убрано из коллекции/.test(calls.noty[0]) && /Настроить/.test(calls.noty[0]), 'подсказка, как вернуть');
        // сервер не ответил: ничего не меняем
        calls.replaced = []; calls.noty = [];
        flow({ 'POST franchises/7/hide': [{ status: 0 }, null] });
        menu[2].onSelect(); await wait(10);
        assert.deepStrictEqual(calls.replaced, []); assert.ok(/Не удалось убрать/.test(calls.noty[0]));
    });

    await test('коллекция: в режиме «Настроить» лишнего меню нет (карточка там переключает «скрыто/видно»)', async function () {
        var s = await openSettings();
        assert.strictEqual(s.sections()[1].cards[0].params.emit.onMenu, undefined);
    });

    await test('«Настроить»: сервер не ответил — состояние не меняется, пользователю сообщение', async function () {
        var s = await openSettings();
        var card = s.sections()[1].cards[0], html = jq();
        card.params.emit.onCreate.call({ html: html });
        flow({ 'POST franchises/7/hide': [{ status: 0 }, null] });
        calls.noty = [];
        card.params.emit.onlyEnter(); await wait(10);
        assert.ok(!html.classes['tapokhub-off'], 'осталась видимой');
        assert.ok(calls.noty.length === 1);
    });

    await test('«Настроить»: добавленное вручную помечено, «Готово» выходит из режима', async function () {
        var s = await openSettings();
        var manual = s.sections()[3].cards[1], html = jq();
        manual.params.emit.onCreate.call({ html: html });
        assert.ok(/ДОБАВЛЕНО/.test(html.badges()[0]));
        calls.replaced = [];
        s.sections()[0].cards[0].params.emit.onlyEnter();
        assert.deepStrictEqual(calls.replaced, [{ settings: false }]);
    });

    await test('«Настроить»: добавить — ввод, поиск, выбор, вопрос «что добавить», добавление, перечитывание экрана', async function () {
        var s = await openSettings();
        var add = s.sections()[0].cards[1];
        calls.input = null; add.params.emit.onlyEnter();
        assert.ok(calls.input && calls.input.params.free && calls.input.params.nosave, 'системная клавиатура Lampa');
        var reqs = [];
        flow({ 'GET *': function (body, path) { reqs.push(path); return [null, { results: [{ id: 337404, media_type: 'movie', title: 'Круэлла', release_date: '2021-05-26' }, { id: 2198, media_type: 'tv', name: 'Сериал', first_air_date: '1997-09-13' }] }]; } });
        calls.select = null; calls.input.cb('  круэлла '); await wait(10);
        assert.ok(/search\?query=%D0%BA%D1%80%D1%83%D1%8D%D0%BB%D0%BB%D0%B0$/.test(reqs[0]), 'запрос без лишних пробелов, с кодированием');
        assert.deepStrictEqual(calls.select.items.map(function (i) { return i.title; }), ['Круэлла (2021)', 'Сериал (1997), сериал']);

        // у выбранного есть коллекция TMDB: спрашиваем, что добавить
        var posted = [];
        flow({ 'POST franchises/7/add-options': [null, { collection: { id: 9, name: '101 далматинец', count: 2 } }],
               'POST franchises/7/add': function (body) { posted.push(body); return [null, {}]; } });
        calls.select.onSelect(calls.select.items[0]); await wait(10);
        assert.deepStrictEqual(calls.select.items.map(function (i) { return i.title; }),
            ['Только «Круэлла»', 'Вся коллекция «101 далматинец» (2 части)', 'Всё связанное: франшиза целиком (поиск займёт время)']);
        calls.replaced = []; calls.noty = [];
        calls.select.onSelect(calls.select.items[1]); await wait(10);
        assert.deepStrictEqual(posted[0], { kind: 'movie', id: 337404, scope: 'collection' });
        assert.deepStrictEqual(calls.replaced, [{}], 'экран перечитан');

        calls.select.onSelect(calls.select.items[2]); await wait(10);
        assert.strictEqual(posted[1].scope, 'related');
        assert.ok(/Ищу связанное/.test(calls.noty[calls.noty.length - 1]), 'предупреждаем, что остальное придёт позже');
        calls.select.onSelect(calls.select.items[0]); await wait(10);
        assert.strictEqual(posted[2].scope, 'item');
    });

    await test('«Настроить»: у выбранного нет коллекции или сервер не ответил на вопрос — предлагаем «только это» и «связанное»', async function () {
        var s = await openSettings();
        var add = s.sections()[0].cards[1];
        flow({ 'GET *': [null, { results: [{ id: 1, media_type: 'tv', name: 'Сериал', first_air_date: '1997-09-13' }] }], 'POST franchises/7/add-options': [null, { collection: null }] });
        add.params.emit.onlyEnter(); calls.input.cb('сер'); await wait(10);
        calls.select.onSelect(calls.select.items[0]); await wait(10);
        assert.deepStrictEqual(calls.select.items.map(function (i) { return i.scope; }), ['item', 'related']);
        flow({ 'GET *': [null, { results: [{ id: 1, media_type: 'tv', name: 'Сериал' }] }], 'POST franchises/7/add-options': [{ status: 0 }, null] });
        add.params.emit.onlyEnter(); calls.input.cb('сер'); await wait(10);
        calls.select.onSelect(calls.select.items[0]); await wait(10);
        assert.deepStrictEqual(calls.select.items.map(function (i) { return i.scope; }), ['item', 'related'], 'без ответа сервера выбор всё равно есть');
    });

    await test('«Настроить»: пустой ввод, ничего не нашли и поиск недоступен — без падений', async function () {
        var s = await openSettings();
        var add = s.sections()[0].cards[1];
        flow({ 'GET *': [null, { results: [] }] });
        calls.select = null; calls.noty = [];
        add.params.emit.onlyEnter(); calls.input.cb(''); await wait(5);
        assert.ok(!calls.select && calls.noty.length === 0, 'пустой ввод: ничего не делаем');
        add.params.emit.onlyEnter(); calls.input.cb('нету'); await wait(10);
        assert.deepStrictEqual(calls.noty, ['Ничего не найдено']);
        flow({ 'GET *': [{ status: 0 }, null] });
        calls.noty = []; add.params.emit.onlyEnter(); calls.input.cb('нету'); await wait(10);
        assert.deepStrictEqual(calls.noty, ['Поиск недоступен']);
    });

    await test('удаление коллекции: экран настройки коллекции — плитка «Удалить коллекцию», подтверждение, удаление на сервере, возврат назад', async function () {
        var s = await openSettings();
        var tile = s.sections()[0].cards[3];
        assert.strictEqual(tile.title, 'Удалить коллекцию');
        var deleted = 0, back = 0, savedBack = Lampa.Activity.backward; Lampa.Activity.backward = function () { back++; };
        flow({ 'POST franchises/7/delete': function () { deleted++; return [null, { deleted: 7 }]; } });
        calls.select = null; calls.noty = [];
        tile.params.emit.onlyEnter();
        assert.ok(/Удалить коллекцию «Сага»\?/.test(calls.select.title), 'сначала спрашиваем');
        assert.deepStrictEqual(calls.select.items.map(function (i) { return i.title; }), ['Да, удалить', 'Нет, оставить']);
        assert.strictEqual(deleted, 0, 'до подтверждения ничего не удалено');
        calls.select.onSelect(calls.select.items[1]); await wait(10);
        assert.strictEqual(deleted, 0, '«Нет»: коллекция на месте'); assert.strictEqual(back, 0);
        tile.params.emit.onlyEnter(); calls.select.onBack(); await wait(10);
        assert.strictEqual(deleted, 0, '«Назад» тоже отказ');
        tile.params.emit.onlyEnter(); calls.select.onSelect(calls.select.items[0]); await wait(20);
        assert.strictEqual(deleted, 1); assert.strictEqual(back, 1, 'после удаления вышли из экрана коллекции');
        assert.ok(calls.noty.some(function (n) { return /Коллекция «Сага» удалена/.test(n); }));
        flow({ 'POST franchises/7/delete': [{ status: 0 }, null] }); back = 0; calls.noty = [];
        tile.params.emit.onlyEnter(); calls.select.onSelect(calls.select.items[0]); await wait(20);
        assert.strictEqual(back, 0, 'не удалось: остаёмся'); assert.ok(calls.noty.some(function (n) { return /Не удалось удалить/.test(n); }));
        Lampa.Activity.backward = savedBack;
    });

    await test('«Настроить»: «Обновить состав» просит сервер пересобрать', async function () {
        var s = await openSettings();
        var posted = 0;
        flow({ 'POST franchises/7/refresh': function () { posted++; return [null, {}]; } });
        calls.noty = [];
        s.sections()[0].cards[2].params.emit.onlyEnter(); await wait(10);
        assert.strictEqual(posted, 1);
        assert.ok(/Обновляю/.test(calls.noty[0]));
    });

    await test('экран франшизы: закрыли до ответа — ничего не строится', async function () {
        flow({ 'GET franchises/7': [null, franchiseDetail()] });
        var screen = calls.components.tapokhub_franchise({ franchise_id: 7 });
        screen.fire('create'); screen.fire('destroy'); await wait(15);
        assert.ok(!screen.built && !screen.emptied);
    });

    /* ---------- «Библиотека» и «Мои коллекции» ---------- */

    var franchiseList = function () {
        return { franchises: [
            summary({ id: 7, title: 'Сага', cover: { backdrop_path: '/bd7.jpg', poster_path: '/pp7.jpg' }, counts: { visible: 11, hidden: 5, new: 2 } }),
            summary({ id: 8, title: 'Собирается', status: 'pending', cover: null }),
            summary({ id: 9, title: 'Слитая', status: 'merged', merged_into: 7 }),
            summary({ id: 10, title: 'Без новых', cover: { backdrop_path: null, poster_path: '/pp10.jpg' }, counts: { visible: 3, hidden: 0, new: 0 } })] };
    };
    var myItems = function () {
        return { items: [{ id: 11, media_type: 'movie', title: 'Новая надежда', poster_path: '/a.jpg', backdrop_path: '/b.jpg' },
                         { id: 82856, media_type: 'tv', name: 'Мандалорец', poster_path: '/m.jpg', backdrop_path: null },
                         { id: 330459, media_type: 'movie', title: 'Изгой-один', poster_path: '/r.jpg', backdrop_path: null }] };
    };
    var openLibrary = async function () { var s = calls.components.tapokhub_library({}); s.fire('create'); await wait(25); return s; };
    var openCollections = async function (extraWait) { var s = calls.components.tapokhub_collections({}); s.fire('create'); await wait(extraWait || 40); return s; };
    var titles = function (s) { return s.sections().map(function (l) { return l.title; }); };

    await test('разделы: «Библиотека», «Рекомендации», «Коллекции», каждый открывает свой экран', function () {
        var list = TH.sections.list();
        assert.deepStrictEqual(list.map(function (s) { return s.id + ':' + s.title; }), ['library:Библиотека', 'recommend:Рекомендации', 'collections:Коллекции']);
        list.forEach(function (s) { assert.ok(s.icon.indexOf('<svg') === 0, s.id + ': есть иконка'); });
        var n = calls.activity.length;
        list[0].open(); list[1].open(); list[2].open();
        assert.deepStrictEqual(calls.activity.slice(n).map(function (a) { return a.component; }), ['tapokhub_library', 'tapokhub_recommend', 'tapokhub_collections']);
    });

    await test('главный экран: английский интерфейс', function () {
        TH.i18n.force('en');
        try {
            var h = newHome(); h.start();
            var screen = stageEl(h.render(true)).children[0];
            var get = function (c) { return screen.children.filter(function (x) { return x.className.indexOf(c) === 0; })[0]; };
            var all = JSON.stringify([get('tapokhub-home__label').textContent, get('tapokhub-home__hint').textContent, screen.innerHTML || '']);
            assert.ok(!/[А-Яа-яЁё]/.test(all), all);
            assert.strictEqual(get('tapokhub-home__hint').textContent, 'CHOOSE A SECTION');
        } finally { TH.i18n.force(''); }
    });

    await test('главный экран: три раздела — выбор появился, ←/→ переключают, OK открывает выбранный', function () {
        var h = newHome(); h.start();
        var screen = stageEl(h.render(true)).children[0];
        var get = function (c) { return screen.children.filter(function (x) { return x.className.indexOf(c) === 0; })[0]; };
        assert.strictEqual(get('tapokhub-home__label').textContent, 'Библиотека');
        assert.strictEqual(get('tapokhub-home__hint').textContent, 'ВЫБЕРИТЕ РАЗДЕЛ');
            assert.ok(get('tapokhub-home__hint').className.indexOf('is-nav') > -1, 'стрелки рисует CSS');
        assert.strictEqual((get('tapokhub-home__dots').innerHTML.match(/<b/g) || []).length, 3);
        var c = calls.controllers.content;
        c.right(); assert.strictEqual(get('tapokhub-home__label').textContent, 'Рекомендации');
        c.right(); assert.strictEqual(get('tapokhub-home__label').textContent, 'Коллекции');
        var n = calls.activity.length; c.enter();
        assert.strictEqual(calls.activity[n].component, 'tapokhub_collections');
    });

    await test('главный экран: сводка — фильмы, сериалы, коллекции и «просмотрено» по отметке Lampa', async function () {
        viewedIds = [11, 82856, 999]; viewedTv = [82856];
        flow({ 'GET stats': [null, { movies: 34, tv: 12, collections: 6, ids: { movie: [11, 5, 6], tv: [82856, 7] } }] });
        var h = newHome(), root = h.render(true);
        var statsEl = stageEl(root).children[0].children.filter(function (c) { return c.className === 'tapokhub-home__stats'; })[0];
        assert.ok(statsEl, 'элемент сводки есть');
        h.start(); await wait(15);
        var text = statsEl.innerHTML;
        assert.ok(/<b>34<\/b><span>ФИЛЬМЫ/.test(text) && /<b>12<\/b><span>СЕРИАЛЫ/.test(text) && /<b>6<\/b><span>КОЛЛЕКЦИИ/.test(text), text);
        assert.ok(/<b>2<\/b><span>ПРОСМОТРЕНО/.test(text), 'просмотрены только те, что есть в списках (999 чужой)');
        viewedIds = [11, 5];
        h.start(); await wait(15);
        assert.ok(/<b>2<\/b><span>ПРОСМОТРЕНО/.test(statsEl.innerHTML) && /<b>34/.test(statsEl.innerHTML), 'при возврате на главный пересчитывается');
        viewedIds = [11, 5, 6];
        h.start(); await wait(15);
        assert.ok(/<b>3<\/b><span>ПРОСМОТРЕНО/.test(statsEl.innerHTML));
        h.destroy();
        viewedIds = []; viewedTv = [];
    });

    await test('главный экран: отметка фильма не засчитывается сериалу с тем же номером (и наоборот)', async function () {
        viewedIds = [7]; viewedTv = [];      // просмотрен ФИЛЬМ с id 7
        flow({ 'GET stats': [null, { movies: 1, tv: 1, collections: 0, ids: { movie: [8], tv: [7] } }] });
        var h = newHome(), root = h.render(true);
        var statsEl = stageEl(root).children[0].children.filter(function (c) { return c.className === 'tapokhub-home__stats'; })[0];
        h.start(); await wait(15);
        assert.ok(/<b>0<\/b><span>ПРОСМОТРЕНО/.test(statsEl.innerHTML), 'сериал 7 не считается просмотренным из-за фильма 7');
        viewedTv = [7];                      // теперь просмотрен СЕРИАЛ 7
        h.start(); await wait(15);
        assert.ok(/<b>1<\/b><span>ПРОСМОТРЕНО/.test(statsEl.innerHTML));
        h.destroy(); viewedIds = []; viewedTv = [];
    });

    await test('видеомагнитофон воспроизводит фильм: по умолчанию выключено; включено — значок PLAY и идущий счётчик минут:секунд, кассеты нет', async function () {
        assert.strictEqual(TH.anim.vcr(), false);
        var byName = {}; (calls.settingsParams || []).forEach(function (p) { if (p.param.name) byName[p.param.name] = p; });
        assert.strictEqual(byName.tapokhub_anim_vcr.param.type, 'trigger');
        assert.strictEqual(byName.tapokhub_anim_vcr.param.default, false);
        assert.ok(/Видеомагнитофон/.test(byName.tapokhub_anim_vcr.field.name) && /PLAY/.test(byName.tapokhub_anim_vcr.field.description));
        var h = newHome(); h.start();
        assert.ok(!/tapokhub-vcr/.test(h.render(true).className), 'по умолчанию значка PLAY нет');
        h.destroy();
        store.tapokhub_anim_vcr = true;
        try {
            var h2 = newHome(); h2.start();
            assert.ok(/tapokhub-vcr/.test(h2.render(true).className));
            var kids = stageEl(h2.render(true)).children.map(function (c) { return c.className; });
            assert.ok(kids.indexOf('tapokhub-home__vcrdisp') > -1, 'дисплей воспроизведения в сцене');
            assert.strictEqual(kids.indexOf('tapokhub-home__vcr'), -1, 'катушек и кассеты нет: на дисплее идёт время');
            var clockEl = stageEl(h2.render(true)).children.filter(function (c) { return c.className === 'tapokhub-home__vcrdisp'; })[0];
            assert.ok(/<polygon class="lit"/.test(clockEl.innerHTML), 'значок PLAY (треугольник)');
            assert.strictEqual((clockEl.innerHTML.match(/<rect class="lit"/g) || []).length, 34, 'мелкое слово PLAY точками 3x5: P 10 + L 7 + A 10 + Y 7');
            var wall = (clockEl.innerHTML.match(/data-c="(\d)"/g) || []).map(function (x) { return x.replace(/\D/g, ''); }).join('');
            assert.strictEqual(wall.length, 4, 'часы остаются на дисплее рядом со счётчиком: ' + wall);
            assert.ok(/class="tape"/.test(clockEl.innerHTML), 'значок кассеты у счётчика');
            var digits = function () { return (clockEl.innerHTML.match(/data-d="(\d)"/g) || []).map(function (x) { return x.replace(/\D/g, ''); }).join(''); };
            assert.strictEqual(digits(), '0000', 'счётчик начинается с 00:00');
            await wait(1150);
            assert.strictEqual(digits(), '0001', 'через секунду 00:01');
            h2.destroy();
        } finally { store.tapokhub_anim_vcr = false; }
        var css = calls.appended[1].html;
        assert.ok(/\.tapokhub-home__vcrdisp\{display:none;position:absolute;left:52\.75%;top:68\.76%;width:3\.708%;height:2\.338%;z-index:1;pointer-events:none/.test(css), 'скрыт без настройки и не ловит касания');
        assert.ok(/\.tapokhub-vcr \.tapokhub-home__clock\{display:none\}/.test(css) && !/tapokhub-playblink|tapokhub-reel/.test(css), 'в режиме воспроизведения часы уступают место счётчику; значок горит ровно, как у видеомагнитофонов 90-х');
    });

    await test('часы на видеомагнитофоне: горят нужные сегменты у каждой цифры, время 24-часовое с ведущим нулём', function () {
        var lit = function (svg, digit) {   // сколько горящих сегментов у цифры в позиции
            return svg.split('<g data-d="')[digit + 1].split('</g>')[0].split('class="on"').length - 1;
        };
        var expected = [6, 2, 5, 5, 4, 5, 6, 3, 7, 6];    // 0..9
        for (var n = 0; n < 10; n++) {
            var svg = TH.clock.svg(n, n === 0 ? 0 : n);
            assert.strictEqual(lit(svg, 1), expected[n], 'цифра ' + n);
        }
        var s = TH.clock.svg(7, 45);
        assert.deepStrictEqual((s.match(/data-d="(\d)"/g) || []).map(function (x) { return +x.replace(/\D/g, ''); }), [0, 7, 4, 5], '07:45');
        assert.ok(/class="colon"/.test(s) && /viewBox="0 0 36 17"/.test(s));
        assert.strictEqual((TH.clock.svg(23, 59).match(/data-d="(\d)"/g) || []).length, 4);
    });

    await test('часы на видеомагнитофоне: на главном экране идёт текущее время, закрывают старые цифры, при уходе таймер снимается', async function () {
        var css = calls.appended[1].html;
        assert.ok(/\.tapokhub-home__clock\{position:absolute;left:53\.53%;top:69\.18%;width:2\.153%;height:1\.807%/.test(css), 'место дисплея в долях кадра 1672x941');
        assert.ok(/pointer-events:none/.test(css.match(/\.tapokhub-home__clock\{[^}]*\}/)[0]));
        var h = newHome(), root = h.render(true);
        var clockEl = stageEl(root).children.filter(function (c) { return c.className === 'tapokhub-home__clock'; })[0];
        assert.ok(clockEl, 'элемент часов в сцене (не в «стекле»)');
        h.start();
        var d = new Date(), digits = (clockEl.innerHTML.match(/data-d="(\d)"/g) || []).map(function (x) { return x.replace(/\D/g, ''); }).join('');
        var want = ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2);
        var d2 = new Date(), want2 = ('0' + d2.getHours()).slice(-2) + ('0' + d2.getMinutes()).slice(-2);
        assert.ok(digits === want || digits === want2, digits + ' vs ' + want);
        h.pause(); h.start(); h.stop(); h.destroy();
    });

    /* ---------- огоньки соединений: сервер, парсер, TorrServer ---------- */

    var realPing = TH.status.ping;
    var pinged = [];
    var pingAnswers = {};       // подстрока адреса -> отвечает ли
    TH.status.ping = function (url, done) {
        pinged.push(url);
        var alive = false;
        Object.keys(pingAnswers).forEach(function (k) { if (url.indexOf(k) > -1) alive = pingAnswers[k]; });
        setTimeout(function () { done(alive); }, 0);
    };
    var resetLeds = function () { pinged = []; pingAnswers = {}; ['parser_use', 'parser_torrent_type', 'parser_use_link', 'jackett_url', 'jackett_key', 'jackett_url_two', 'jackett_key_two', 'prowlarr_url', 'prowlarr_key', 'prowlarr_url_two', 'prowlarr_key_two', 'torrserver_url', 'torrserver_url_two', 'torrserver_use_link'].forEach(function (k) { delete store[k]; }); Lampa.Torserver = { url: function () { return store.torrserver_url || ''; } }; };
    var checkAll = function () { return new Promise(function (r) { TH.status.check(null, r); }); };

    await test('соединения: парсер выключен или без адреса — «не задан», TorrServer без адреса тоже', async function () {
        resetLeds();
        var r = await checkAll();
        assert.strictEqual(r.parser, 'off'); assert.strictEqual(r.torrserver, 'off');
        store.parser_use = true;
        assert.strictEqual((await checkAll()).parser, 'off', 'парсер включён, но адреса нет');
        assert.deepStrictEqual(pinged, [], 'без адресов никуда не ходим');
    });

    await test('соединения: Jackett — проверяется адрес из настроек Lampa с ключом, отвечает -> ok, молчит -> bad', async function () {
        resetLeds(); store.parser_use = true; store.parser_torrent_type = 'jackett'; store.jackett_url = 'jac.example'; store.jackett_key = 'k e/y';
        pingAnswers['jac.example'] = true;
        assert.strictEqual((await checkAll()).parser, 'ok');
        assert.ok(pinged.indexOf('jac.example/api/v2.0/indexers?configured=true&apikey=k%20e%2Fy') > -1, pinged.join(' | '));
        pingAnswers['jac.example'] = false;
        assert.strictEqual((await checkAll()).parser, 'bad');
    });

    await test('соединения: два адреса парсера — как выбирает Lampa (первый, второй, оба); достаточно одного живого', async function () {
        resetLeds(); store.parser_use = true; store.jackett_url = 'a.example'; store.jackett_url_two = 'b.example';
        pingAnswers = { 'a.example': false, 'b.example': true };
        store.parser_use_link = 'one'; assert.strictEqual((await checkAll()).parser, 'bad', 'выбран первый, он молчит');
        store.parser_use_link = 'two'; assert.strictEqual((await checkAll()).parser, 'ok');
        store.parser_use_link = 'all'; pinged = []; assert.strictEqual((await checkAll()).parser, 'ok', 'Lampa объединяет ответы: хватает одного');
        assert.strictEqual(pinged.filter(function (u) { return /example/.test(u); }).length, 2);
    });

    await test('соединения: Prowlarr и «парсер = TorrServer» проверяются своими адресами', async function () {
        resetLeds(); store.parser_use = true; store.parser_torrent_type = 'prowlarr'; store.prowlarr_url = 'prow.example'; store.prowlarr_key = 'K';
        pingAnswers['prow.example'] = true;
        assert.strictEqual((await checkAll()).parser, 'ok');
        assert.ok(pinged.indexOf('prow.example/api/v1/system/status?apikey=K') > -1);
        resetLeds(); store.parser_use = true; store.parser_torrent_type = 'torrserver'; store.torrserver_url = 'ts.example:8090';
        pingAnswers['ts.example'] = true;
        var r = await checkAll();
        assert.strictEqual(r.parser, 'ok'); assert.strictEqual(r.torrserver, 'ok');
        assert.ok(pinged.indexOf('ts.example:8090/echo') > -1, 'у TorrServer проверяется /echo');
    });

    await test('соединения: наш сервер — нет входа «не задан», отвечает ok, не отвечает bad', async function () {
        var saved = TH.proxy.base(), transport = TH.lib.transport;
        TH.proxy.configure('');
        assert.strictEqual((await checkAll()).server, 'off');
        TH.proxy.configure('https://hub.test/tmdb/tok');
        var asked = [];
        TH.lib.transport = function (m, u, b, cb) { asked.push(u); cb(null, { id: 1 }); };
        assert.strictEqual((await checkAll()).server, 'ok');
        assert.deepStrictEqual(asked, ['https://hub.test/tmdb/tok/whoami']);
        TH.lib.transport = function (m, u, b, cb) { cb({ status: 0 }, null); };
        assert.strictEqual((await checkAll()).server, 'bad');
        TH.lib.transport = transport; TH.proxy.configure(saved);
    });

    await test('соединения: ping — любой ответ сервера (даже ошибка доступа) значит «жив», отсутствие ответа — нет', async function () {
        var savedReq = Lampa.Reguest;
        var mk = function (mode) { return function () { this.timeout = function () {}; this.silent = function (u, ok, err) { setTimeout(function () { if (mode === 'ok') ok('x'); else err({ status: mode }); }, 0); }; }; };
        var run = function (mode) { Lampa.Reguest = mk(mode); return new Promise(function (r) { realPing('x', r); }); };
        assert.strictEqual(await run('ok'), true);
        assert.strictEqual(await run(401), true, '401 — сервер есть, просто нужен ключ');
        assert.strictEqual(await run(500), true);
        assert.strictEqual(await run(0), false, 'статус 0 — сети или ответа нет');
        Lampa.Reguest = function () { throw new Error('нет транспорта'); };
        assert.strictEqual(await new Promise(function (r) { realPing('x', r); }), false, 'сбой транспорта не роняет экран');
        Lampa.Reguest = savedReq;
    });

    await test('соединения: на главном экране три огонька меняют цвет по ответам и обновляются раз в минуту, пока экран открыт', async function () {
        resetLeds(); store.parser_use = true; store.jackett_url = 'jac.example'; store.torrserver_url = 'ts.example';
        pingAnswers = { 'jac.example': true, 'ts.example': false };
        var saved = TH.proxy.base(); TH.proxy.configure('');
        var h = newHome(), root = h.render(true);
        var ledsEl = stageEl(root).children[0].children.filter(function (c) { return c.className === 'tapokhub-home__leds'; })[0];
        assert.ok(ledsEl, 'блок огоньков внутри «стекла»');
        h.start(); await wait(20);
        var html = ledsEl.innerHTML;
        assert.ok(/is-off"><i><\/i><b>СЕРВЕР<\/b>/.test(html), 'нет входа: сервер «не задан»');
        assert.ok(/is-ok"><i><\/i><b>ПАРСЕР<\/b>/.test(html), 'парсер отвечает');
        assert.ok(/is-bad"><i><\/i><b>ТОРРС<\/b>/.test(html), 'TorrServer молчит, подпись по-русски: ТОРРС');
        var css = calls.appended[1].html;
        assert.ok(/\.tapokhub-home__leds\{[^}]*pointer-events:none/.test(css) && /is-ok i\{background:#5dff8f/.test(css) && /is-bad i\{background:#ff4b4b/.test(css));
        var before = pinged.length; h.pause(); await wait(20);
        h.destroy(); TH.proxy.configure(saved);
        assert.strictEqual(pinged.length, before, 'после ухода с экрана проверки прекращены');
    });

    TH.status.ping = realPing; resetLeds(); Lampa.Torserver = undefined;

    await test('светодиод на корпусе телевизора: цвет по состоянию соединений (зелёный, жёлтый, красный, без входа тусклый)', async function () {
        var saved = TH.proxy.base(), transport = TH.lib.transport, ping0 = TH.status.ping;
        TH.status.ping = function (url, done) { var alive = false; Object.keys(pingAnswers).forEach(function (k) { if (url.indexOf(k) > -1) alive = pingAnswers[k]; }); setTimeout(function () { done(alive); }, 0); };
        var run = async function (serverAnswer, pingMap) {
            resetLeds(); Object.keys(pingMap).forEach(function (k) { pingAnswers[k] = pingMap[k]; });
            if (pingMap.__parser) { store.parser_use = true; store.jackett_url = 'jac.example'; }
            TH.lib.transport = function (m, u, b, cb) { serverAnswer === 'ok' ? cb(null, { id: 1 }) : cb({ status: 0 }, null); };
            var h = newHome(), root = h.render(true);
            var led = stageEl(root).children.filter(function (c) { return /^tapokhub-home__tvled/.test(c.className); })[0];
            assert.ok(led, 'светодиод в сцене (на корпусе телевизора), не в «стекле»');
            var wait0 = led.className;
            h.start(); await wait(25);
            var cls = led.className; h.destroy();
            return cls.replace('tapokhub-home__tvled', '').trim();
        };
        TH.proxy.configure('https://hub.test/tmdb/tok');
        assert.strictEqual(await run('ok', {}), 'is-ok', 'сервер отвечает, парсер и TorrServer не заданы: всё, что настроено, работает');
        assert.strictEqual(await run('ok', { 'jac.example': false, __parser: true }), 'is-warn', 'парсер настроен, но молчит');
        assert.strictEqual(await run('bad', {}), 'is-bad', 'наш сервер не отвечает');
        TH.proxy.configure('');
        assert.strictEqual(await run('ok', {}), '', 'нет входа: светодиод тусклый');
        TH.lib.transport = transport; TH.proxy.configure(saved); TH.status.ping = ping0; resetLeds();
        var css = calls.appended[1].html;
        assert.ok(/\.tapokhub-home__tvled\{position:absolute;left:71\.5%;top:58\.4%/.test(css) && /pointer-events:none/.test(css.match(/\.tapokhub-home__tvled\{[^}]*\}/)[0]));
        assert.ok(/tvled\.is-ok\{background:#5dff8f/.test(css) && /tvled\.is-warn\{background:#ffd24a/.test(css) && /tvled\.is-bad\{background:#ff4b4b/.test(css));
        assert.ok(!/tapokhub-home__ch|tapokhub-osd/.test(css), 'номера канала нет');
    });

    // Боевые значения по умолчанию подогнаны под стекло телевизора владельца. Остальные тесты считают от ровного прямоугольника,
    // поэтому на время тестов подставляем нейтральную базу, а боевые значения проверяет отдельный тест ниже.
    var fxShipped = Object.assign({}, TH.fx.defaults);
    TH.fx.defaults = { radius: 14, left: 5, right: 5, top: 15, bottom: 15, tlx: 0, tly: 0, trx: 0, try: 0, blx: 0, bly: 0, brx: 0, bry: 0,
        nTop: 0, nBottom: 0, nLeft: 0, nRight: 0, bTop: 0, bBottom: 0, bLeft: 0, bRight: 0 };
    var fxKeys = Object.keys(TH.fx.defaults);
    (calls.settingsParams || []).forEach(function (p) {   // заглушка Lampa отдаёт значение по умолчанию из зарегистрированного параметра
        var m = /^tapokhub_fx_(.+)$/.exec(p.param.name);
        if (m && m[1] in fxShipped) { assert.strictEqual(p.param.default, String(fxShipped[m[1]]), 'в настройках по умолчанию боевое значение ' + m[1]); p.param.default = String(TH.fx.defaults[m[1]]); }
    });
    await test('область помех: боевые значения по умолчанию — подгонка владельца, набор ключей тот же, что у нейтральной базы', function () {
        assert.deepStrictEqual(Object.keys(fxShipped), Object.keys(TH.fx.defaults));
        assert.deepStrictEqual(fxShipped, { radius: 14, left: 8, right: -10, top: 6, bottom: 4, tlx: 0, tly: 3, trx: -40, try: 1, blx: 5, bly: -4, brx: -45, bry: -5,
            nTop: 8, nBottom: 0, nLeft: 0, nRight: 0, bTop: 8, bBottom: 7, bLeft: 8, bRight: 9 });
        Object.keys(fxShipped).forEach(function (k) { assert.ok(fxShipped[k] >= TH.fx.limits.min && fxShipped[k] <= TH.fx.limits.max, k + ' в пределах'); });
    });
    var fxClear = function () { fxKeys.forEach(function (k) { delete store['tapokhub_fx_' + k]; }); };
    var fxShape = function (o) { fxClear(); Object.keys(o).forEach(function (k) { store['tapokhub_fx_' + k] = String(o[k]); }); var s = TH.fx.shape(TH.fx.all()); fxClear(); return s; };
    var fxPts = function (s) { return s.replace(/^polygon\(|\)$/g, '').split(/,(?![^(]*\))/); };   // точки, запятые внутри calc() не режут

    await test('область помех: по умолчанию ровный прямоугольник из четырёх точек с отступами 5/5/15/15', function () {
        fxClear();
        assert.deepStrictEqual(fxPts(TH.fx.shape(TH.fx.all())), ['5px 15px', 'calc(100% - 5px) 15px', 'calc(100% - 5px) calc(100% - 15px)', '5px calc(100% - 15px)']);
        assert.ok(calls.appended[1].html.indexOf('clip-path:' + TH.fx.shape(fxShipped)) > -1, 'до применения настроек в стилях форма из боевых значений по умолчанию');
    });

    await test('скругление углов: дуга радиуса r в каждом из четырёх углов, прямые стороны без лишних точек, радиус не больше половины стороны', function () {
        var v = function (o) { fxClear(); Object.keys(o).forEach(function (k) { store['tapokhub_fx_' + k] = String(o[k]); }); var x = TH.fx.all(); fxClear(); return x; };
        var flat = TH.fx.outline(v({ radius: 0 }), 500, 280);
        assert.strictEqual(flat.length, 4, 'без скругления четыре угла');
        var r = TH.fx.outline(v({ radius: 20 }), 500, 280);
        assert.strictEqual(r.length, 4 * 9, 'каждый угол: девять точек дуги');
        assert.deepStrictEqual([r[0].x, r[0].y], [5, 35], 'дуга левого верхнего угла начинается в 20 px от угла вдоль левой стороны');
        assert.deepStrictEqual([r[8].x, r[8].y], [25, 15], 'и заканчивается в 20 px вдоль верхней');
        assert.ok(r.every(function (p) { return p.x >= 5 - 1e-9 && p.x <= 495 + 1e-9 && p.y >= 15 - 1e-9 && p.y <= 265 + 1e-9; }), 'дуги не выходят за прямоугольник');
        var mid = r[4]; assert.ok(mid.x > 5 && mid.y > 15 && mid.x < 20 && mid.y < 30, 'середина дуги срезает угол внутрь');
        var big = TH.fx.outline(v({ radius: 1000 }), 500, 280);
        assert.deepStrictEqual([big[0].x, big[0].y], [5, 15 + 125], 'радиус ограничен половиной стороны (250 / 2)');
        var trap = TH.fx.outline(v({ radius: 10, nTop: 30 }), 500, 280);
        assert.ok(trap.length === 36 && trap[0].x > 30 && trap[0].x < 45 || trap[0].y > 15, 'скругление работает и у трапеции');
    });

    await test('скругление углов: применяется в пикселях по измеренному размеру стекла, скругление 0 возвращает форму в процентах; по умолчанию углы скруглены', function () {
        fxClear();
        var node = { style: {}, getBoundingClientRect: function () { return { width: 600, height: 320 }; } };
        TH.fx.apply(node);
        assert.ok(/^polygon\(5px \d+(\.\d+)?px,/.test(node.style.clipPath) && !/%/.test(node.style.clipPath), 'по умолчанию радиус ' + TH.fx.defaults.radius + ' px: точки в пикселях, начало дуги у левого края');
        assert.strictEqual(node.style.webkitClipPath, node.style.clipPath);
        var n1 = node.style.clipPath.split(',').length;
        store.tapokhub_fx_radius = '0'; TH.fx.apply(node);
        assert.strictEqual(node.style.clipPath, 'polygon(5px 15px,calc(100% - 5px) 15px,calc(100% - 5px) calc(100% - 15px),5px calc(100% - 15px))', 'без скругления процентная форма, подстраивается под любой размер');
        assert.ok(n1 > 4);
        fxClear();
        var noRect = { style: {} }; TH.fx.apply(noRect);
        assert.ok(/px/.test(noRect.style.clipPath), 'размер не измерить — берётся размер по умолчанию');
    });

    await test('область помех: отступы двигают стороны, отрицательные выдвигают за край стекла', function () {
        assert.deepStrictEqual(fxPts(fxShape({ left: 0, right: 40, top: 30, bottom: -6 })), ['0% 30px', 'calc(100% - 40px) 30px', 'calc(100% - 40px) calc(100% + 6px)', '0% calc(100% + 6px)']);
    });

    await test('область помех: каждый из четырёх углов сдвигается по X и Y независимо', function () {
        var p = fxPts(fxShape({ tlx: 10, tly: -4, trx: -3, try: 6, blx: 2, bly: -8, brx: 7, bry: 9 }));
        assert.deepStrictEqual(p, ['15px 11px', 'calc(100% - 8px) 21px', 'calc(100% - 5px + 7px) calc(100% - 15px + 9px)'.replace('calc(100% - 5px + 7px)', 'calc(100% + 2px)').replace('calc(100% - 15px + 9px)', 'calc(100% - 6px)'), '7px calc(100% - 23px)']);
    });

    await test('область помех: трапеция — сужение верха, низа, левой и правой сторон', function () {
        var top = fxPts(fxShape({ nTop: 20 }));
        assert.strictEqual(top[0], '25px 15px', 'верхняя сторона уже: левый верхний угол вправо');
        assert.strictEqual(top[1], 'calc(100% - 25px) 15px', 'правый верхний влево');
        assert.strictEqual(top[2], 'calc(100% - 5px) calc(100% - 15px)', 'низ не тронут');
        var bottom = fxPts(fxShape({ nBottom: 8 }));
        assert.strictEqual(bottom[3], '13px calc(100% - 15px)'); assert.strictEqual(bottom[2], 'calc(100% - 13px) calc(100% - 15px)');
        var left = fxPts(fxShape({ nLeft: 12 }));
        assert.strictEqual(left[0], '5px 27px', 'левая сторона короче: верх ниже'); assert.strictEqual(left[3], '5px calc(100% - 27px)', 'низ выше');
        assert.strictEqual(left[1], 'calc(100% - 5px) 15px', 'правая сторона не тронута');
        var right = fxPts(fxShape({ nRight: -6 }));
        assert.strictEqual(right[1], 'calc(100% - 5px) 9px', 'минус — длиннее: правый верхний угол выше');
        assert.strictEqual(right[2], 'calc(100% - 5px) calc(100% - 9px)');
    });

    await test('область помех: выгиб сторон — середина смещается на число, плюс наружу, минус внутрь; прямые стороны без лишних точек', function () {
        var top = fxPts(fxShape({ bTop: 10 }));
        assert.strictEqual(top.length, 12 + 3, 'выгнутая сторона режется на 12 отрезков, остальные без лишних точек');
        assert.strictEqual(top[6], '50% 5px', 'середина верха на 10 px выше линии (15 - 10)');
        assert.strictEqual(top[0], '5px 15px', 'углы на месте');
        assert.strictEqual(fxPts(fxShape({ bTop: -10 }))[6], '50% 25px', 'минус — внутрь');
        var right = fxPts(fxShape({ bRight: 6 })); var mid = right.filter(function (x) { return /calc\(100% \+ 1px\) 50%/.test(x); });
        assert.strictEqual(mid.length, 1, 'середина правой стороны на 6 px правее линии (−5 + 6)');
        assert.ok(fxPts(fxShape({ bBottom: 4 })).some(function (x) { return x === '50% calc(100% - 11px)'; }), 'низ: наружу — вниз');
        assert.ok(fxPts(fxShape({ bLeft: 9 })).some(function (x) { return x === '-4px 50%'; }), 'лево: наружу — влево (5 − 9)');
    });

    await test('область помех: ввод разбирается (запятая, пробелы, мусор), пределы ±300, значения по умолчанию', function () {
        fxClear();
        store.tapokhub_fx_left = '-12,5'; store.tapokhub_fx_top = ' 20 '; store.tapokhub_fx_right = 'abc'; store.tapokhub_fx_bottom = '9999'; store.tapokhub_fx_bTop = '-9999';
        var v = TH.fx.all();
        assert.deepStrictEqual([v.left, v.top, v.right, v.bottom, v.bTop, v.tlx], [-12.5, 20, 5, 300, -300, 0]);
        fxClear();
        Object.keys(TH.fx.defaults).forEach(function (k) {
            var pg = (calls.settingsParams || []).filter(function (p) { return p.param.name === 'tapokhub_fx_' + k; })[0];
            assert.ok(pg && pg.param.type === 'input' && pg.param.default === String(TH.fx.defaults[k]) && /px/.test(pg.field.name), 'поле ' + k + ' есть, числовое, с единицами');
        });
    });

    await test('область помех: форма из настроек кладётся на элемент при входе на главный экран', function () {
        fxClear(); store.tapokhub_fx_nTop = '20'; store.tapokhub_fx_bTop = '10'; store.tapokhub_fx_radius = '0';
        var h = newHome(), root = h.render(true);
        var fxEl = stageEl(root).children[0].children.filter(function (c) { return c.className === 'tapokhub-home__fx'; })[0];
        fxEl.style = fxEl.style || {};
        h.start();
        assert.ok(/^polygon\(25px 15px,/.test(fxEl.style.clipPath) && fxEl.style.webkitClipPath === fxEl.style.clipPath, 'применено с учётом сужения верха и выгиба: ' + fxEl.style.clipPath.slice(0, 60));
        assert.ok(/50% 5px/.test(fxEl.style.clipPath));
        h.destroy();
        fxClear();
    });

    await test('область помех: «Показать текущие значения» одной строкой и «Сбросить» возвращают ровный прямоугольник', function () {
        var byName = {}; (calls.settingsParams || []).forEach(function (p) { if (p.component === 'tapokhub_fx' && p.param.name) byName[p.param.name] = p; });
        fxClear(); store.tapokhub_fx_left = '7'; store.tapokhub_fx_tly = '-3'; store.tapokhub_fx_nTop = '20'; store.tapokhub_fx_bRight = '4'; calls.noty = [];
        byName.tapokhub_fx_show.onChange();
        assert.strictEqual(calls.noty[0], 'Область помех: отступы: слева 7, справа 5, сверху 15, снизу 15, скругление 14; углы: лв.y -3; трапеция: верх 20; выгиб: право 4');
        fxClear(); calls.noty = []; byName.tapokhub_fx_show.onChange();
        assert.strictEqual(calls.noty[0], 'Область помех: отступы: слева 5, справа 5, сверху 15, снизу 15, скругление 14', 'без изменений: только отступы и скругление');
        var setKeys = {}, setBefore = Lampa.Storage.set; Lampa.Storage.set = function (k, v) { setKeys[k] = v; };
        byName.tapokhub_fx_reset.onChange(); Lampa.Storage.set = setBefore;
        assert.strictEqual(Object.keys(setKeys).length, 21, 'сброшены все двадцать один параметр');
        assert.strictEqual(setKeys.tapokhub_fx_left, '5'); assert.strictEqual(setKeys.tapokhub_fx_bTop, '0'); assert.strictEqual(setKeys.tapokhub_fx_tlx, '0'); assert.strictEqual(setKeys.tapokhub_fx_radius, '14');
        fxClear();
    });

    /* ---------- настройка области помех прямо на экране ---------- */

    var edSetKeys = {};
    var edStart = function (extra) {
        fxClear(); edSetKeys = {}; store.tapokhub_fx_radius = '0';   // скругление отдельно проверяется ниже; здесь форма из прямых линий
        var setBefore = Lampa.Storage.set;
        Lampa.Storage.set = function (k, v) { edSetKeys[k] = v; if (k.indexOf('tapokhub_fx_') === 0) store[k] = v; };
        var h = new (calls.components.tapokhub_home)(Object.assign({ tapokhub_fxedit: true }, extra || {}));
        var root = h.render(true);
        var stage = stageEl(root);
        h.create ? h.create() : 0;
        h.start();
        var box = stage.children.filter(function (c) { return c.className === 'tapokhub-home__fxedit'; })[0];
        return { h: h, root: root, box: box, restore: function () { Lampa.Storage.set = setBefore; fxClear(); edSetKeys = {}; },
            handle: function (n) { return box.children.filter(function (c) { return new RegExp('is-' + n + '(\\s|$)').test(c.className); })[0]; } };
    };
    var pointer = function (type, x, y) { domFire(type, { clientX: x, clientY: y }); };
    var downOn = function (node, x, y) { node.fire('pointerdown', { clientX: x, clientY: y, preventDefault: function () {}, stopPropagation: function () {} }); };

    await test('правка на экране: главный экран в режиме правки показывает рамку, девять ручек, панель и включает помехи', function () {
        var ed = edStart();
        try {
            assert.ok(ed.box, 'редактор в сцене');
            assert.strictEqual((ed.box.children.filter(function (c) { return /tapokhub-home__fxedit__h/.test(c.className); })).length, 9, '4 угла, 4 середины сторон, рамка целиком');
            assert.ok(/<polygon points="/.test(ed.box.children.filter(function (c) { return /outline/.test(c.className); })[0].innerHTML), 'контур нарисован');
            var panel = ed.box.children.filter(function (c) { return /panel/.test(c.className); })[0];
            assert.ok(/Область помех: отступы: слева 5/.test(panel.children[0].textContent), 'строка со значениями видна на экране');
            assert.deepStrictEqual(panel.children[1].children.map(function (b) { return b.textContent; }), ['Скругл. −', 'Скругл. +', 'Готово', 'Сбросить']);
            assert.ok(/tapokhub-crt/.test(ed.root.className), 'помехи включены, чтобы видеть результат');
            ed.h.destroy();
            assert.ok(!ed.box.parentNode, 'редактор убран вместе с экраном');
        } finally { ed.restore(); }
    });

    await test('правка на экране: обычный вход на главный экран без редактора', function () {
        fxClear();
        var h = newHome(), root = h.render(true); h.start();
        assert.strictEqual(stageEl(root).children.filter(function (c) { return c.className === 'tapokhub-home__fxedit'; }).length, 0);
        h.destroy();
    });

    await test('правка на экране: угол тянется — сдвиг угла по X и Y, значения сохраняются при отпускании; форма обновляется на лету', function () {
        var ed = edStart();
        try {
            var tl = ed.handle('tl');
            var fxEl = stageEl(ed.root).children[0].children.filter(function (c) { return c.className === 'tapokhub-home__fx'; })[0];
            downOn(tl, 100, 100);
            pointer('pointermove', 110, 95);
            assert.ok(/^polygon\(15px 10px,/.test(fxEl.style.clipPath), 'форма меняется, пока тянем: ' + fxEl.style.clipPath.slice(0, 40));
            assert.deepStrictEqual(edSetKeys, {}, 'пока тянем, не пишем в настройки');
            pointer('pointerup', 110, 95);
            assert.strictEqual(edSetKeys.tapokhub_fx_tlx, '10'); assert.strictEqual(edSetKeys.tapokhub_fx_tly, '-5');
            assert.strictEqual(tl.style.left, '15px', 'ручка стоит на новом месте');
            pointer('pointermove', 300, 300);
            assert.ok(/^polygon\(15px 10px,/.test(fxEl.style.clipPath), 'после отпускания движение мыши ничего не меняет');
        } finally { ed.h.destroy(); ed.restore(); }
    });

    await test('правка на экране: середина стороны — выгиб (плюс наружу), рамка целиком — отступы; пределы ±300', function () {
        var ed = edStart();
        try {
            downOn(ed.handle('top'), 250, 15); pointer('pointermove', 250, 5); pointer('pointerup', 250, 5);
            assert.strictEqual(edSetKeys.tapokhub_fx_bTop, '10', 'потянули вверх на 10: верх выгнулся наружу');
            downOn(ed.handle('right'), 495, 140); pointer('pointermove', 485, 140); pointer('pointerup', 485, 140);
            assert.strictEqual(edSetKeys.tapokhub_fx_bRight, '-10', 'право потянули влево: внутрь');
            downOn(ed.handle('bottom'), 250, 265); pointer('pointermove', 250, 275); pointer('pointerup', 250, 275);
            assert.strictEqual(edSetKeys.tapokhub_fx_bBottom, '10');
            downOn(ed.handle('left'), 5, 140); pointer('pointermove', -5, 140); pointer('pointerup', -5, 140);
            assert.strictEqual(edSetKeys.tapokhub_fx_bLeft, '10');
            edSetKeys = {};
            downOn(ed.handle('pan'), 250, 140); pointer('pointermove', 256, 130); pointer('pointerup', 256, 130);
            assert.deepStrictEqual([edSetKeys.tapokhub_fx_left, edSetKeys.tapokhub_fx_right, edSetKeys.tapokhub_fx_top, edSetKeys.tapokhub_fx_bottom], ['11', '-1', '5', '25'], 'рамка съехала: вправо на 6 и вверх на 10');
            edSetKeys = {};
            downOn(ed.handle('pan'), 250, 140); pointer('pointermove', 9999, 140); pointer('pointerup', 9999, 140);
            assert.strictEqual(edSetKeys.tapokhub_fx_left, '300', 'предел 300');
        } finally { ed.h.destroy(); ed.restore(); }
    });

    await test('правка на экране: пульт — OK выбирает следующую ручку, стрелки двигают выбранную на 1 px, «Назад» сохраняет и выходит', function () {
        var ed = edStart();
        var back = 0, savedBack = Lampa.Activity.backward; Lampa.Activity.backward = function () { back++; };
        try {
            var c = calls.controllers.content;
            c.right(); c.down();
            assert.strictEqual(edSetKeys.tapokhub_fx_tlx, '1'); assert.strictEqual(edSetKeys.tapokhub_fx_tly, '1', 'выбран левый верхний угол: стрелки двигают его');
            c.enter(); c.up(); c.up();
            assert.strictEqual(edSetKeys.tapokhub_fx_try, '-2', 'следующая ручка — правый верхний угол');
            c.enter(); c.enter(); c.enter(); c.left();
            assert.strictEqual(edSetKeys.tapokhub_fx_bTop, '0', 'стрелка влево у ручки верха выгиб не меняет');
            c.up(); assert.strictEqual(edSetKeys.tapokhub_fx_bTop, '1', 'ручка верха: стрелка вверх выгибает наружу');
            c.enter(); c.right(); assert.strictEqual(edSetKeys.tapokhub_fx_bRight, '1');
            c.back();
            assert.strictEqual(back, 1, '«Назад»: закрыли редактор и вернулись');
            assert.ok(!ed.box.parentNode);
        } finally { Lampa.Activity.backward = savedBack; ed.h.destroy(); ed.restore(); }
    });

    await test('правка на экране: кнопки «Готово» и «Сбросить»; касания на экране в режиме правки не листают разделы', function () {
        var ed = edStart();
        var back = 0, savedBack = Lampa.Activity.backward; Lampa.Activity.backward = function () { back++; };
        try {
            downOn(ed.handle('tl'), 10, 10); pointer('pointermove', 30, 40); pointer('pointerup', 30, 40);
            var panel = ed.box.children.filter(function (c) { return /panel/.test(c.className); })[0];
            var btn = function (name) { return panel.children[1].children.filter(function (b) { return b.textContent === name; })[0]; };
            edSetKeys = {}; downOn(btn('Сбросить'), 0, 0);
            assert.strictEqual(Object.keys(edSetKeys).length, 21, 'сброшены все двадцать один параметр');
            assert.strictEqual(edSetKeys.tapokhub_fx_left, '5'); assert.strictEqual(edSetKeys.tapokhub_fx_tlx, '0'); assert.strictEqual(edSetKeys.tapokhub_fx_radius, '14');
            // касание по экрану: разделы не листаются (индекс не меняется)
            var idx = ed.h.state().index;
            ed.root.fire('touchstart', { touches: [{ clientX: 500, clientY: 100 }], target: ed.root });
            ed.root.fire('touchend', { changedTouches: [{ clientX: 100, clientY: 100 }], target: ed.root, cancelable: true, preventDefault: function () {} });
            assert.strictEqual(ed.h.state().index, idx);
            downOn(btn('Готово'), 0, 0);
            assert.strictEqual(back, 1);
        } finally { Lampa.Activity.backward = savedBack; ed.h.destroy(); ed.restore(); }
    });

    await test('правка на экране: из настроек открывается главный экран в режиме правки', function () {
        var byComp = {}; (calls.settingsParams || []).forEach(function (p) { (byComp[p.component] = byComp[p.component] || []).push(p); });
        var btn = byComp.tapokhub_fx.filter(function (p) { return p.param.name === 'tapokhub_fx_edit'; })[0];
        calls.activity.length = 0;
        btn.onChange();
        assert.strictEqual(calls.activity.length, 1);
        assert.strictEqual(calls.activity[0].component, 'tapokhub_home'); assert.strictEqual(calls.activity[0].tapokhub_fxedit, true);
    });

    await test('скругление углов: кнопки в редакторе «Скругл. −» и «Скругл. +» меняют радиус на 2 px, не меньше нуля', function () {
        var ed = edStart();
        try {
            var panel = ed.box.children.filter(function (c) { return /panel/.test(c.className); })[0];
            var btn = function (name) { return panel.children[1].children.filter(function (b) { return b.textContent === name; })[0]; };
            downOn(btn('Скругл. +'), 0, 0); assert.strictEqual(edSetKeys.tapokhub_fx_radius, '2');
            downOn(btn('Скругл. +'), 0, 0); assert.strictEqual(edSetKeys.tapokhub_fx_radius, '4');
            downOn(btn('Скругл. −'), 0, 0); downOn(btn('Скругл. −'), 0, 0); downOn(btn('Скругл. −'), 0, 0);
            assert.strictEqual(edSetKeys.tapokhub_fx_radius, '0', 'ниже нуля не бывает');
            assert.ok(/скругление 0/.test(panel.children[0].textContent));
        } finally { ed.h.destroy(); ed.restore(); }
    });

    /* ---------- синхронизация настроек плагина с сервером ---------- */

    var syncPosts = [];
    var syncBase = TH.proxy.base();

    await test('синхронизация настроек: изменение известной настройки уходит на сервер одним запросом после паузы; токен и посторонние не уходят', async function () {
        TH.proxy.configure(LB); lstore = {}; syncPosts = []; store.tapokhub_x = 0;
        flow({ 'POST settings': function (body) { syncPosts.push(body.settings); return [null, { saved: Object.keys(body.settings).reduce(function (o, k) { o[k] = 5000; return o; }, {}) }]; } });
        var savedSet = Lampa.Storage.set;
        Lampa.Storage.set('tapokhub_fx_left', '9'); Lampa.Storage.set('tapokhub_fx_top', '21'); Lampa.Storage.set('tapokhub_anim_crt', true);
        Lampa.Storage.set('tapokhub_token', 'секрет'); Lampa.Storage.set('tapokhub_torrents', {}); Lampa.Storage.set('чужая', 1);
        assert.strictEqual(syncPosts.length, 0, 'сразу не шлём: пользователь может ещё печатать');
        await wait(2100);
        assert.deepStrictEqual(syncPosts, [{ tapokhub_fx_left: '9', tapokhub_fx_top: '21', tapokhub_anim_crt: 'true' }], 'три изменения — один запрос, только известные ключи');
        assert.deepStrictEqual(lstore.tapokhub_settings_meta, { tapokhub_fx_left: 5000, tapokhub_fx_top: 5000, tapokhub_anim_crt: 5000 }, 'время записи с сервера запомнено');
        TH.proxy.configure('');
        Lampa.Storage.set('tapokhub_fx_left', '11'); await wait(2100);
        assert.strictEqual(syncPosts.length, 1, 'без входа на сервер не шлём');
        TH.proxy.configure(syncBase);
    });

    await test('синхронизация настроек: серверные значения главнее старого локального кеша; повторно их не отправляем', async function () {
        TH.proxy.configure(LB); syncPosts = [];
        lstore = { tapokhub_fx_left: '3', tapokhub_fx_right: '4', tapokhub_fx_bottom: '8', tapokhub_settings_meta: { tapokhub_fx_right: 1000, tapokhub_fx_bottom: 2000 } };
        var got = {
            tapokhub_fx_left: { value: '77', at: 900 },        // на устройстве 3, учёта нет: значение устройства главнее -> уходит на сервер
            tapokhub_fx_right: { value: '44', at: 3000 },      // на сервере новее учтённого (1000): берём
            tapokhub_fx_bottom: { value: '8', at: 2000 },      // то же самое: ничего
            tapokhub_fx_top: { value: '25', at: 500 },         // здесь не было: берём
            tapokhub_anim_vcr: { value: 'true', at: 600 }
        };
        flow({ 'GET settings': [null, { settings: got }], 'POST settings': function (body) { syncPosts.push(body.settings); return [null, { saved: { tapokhub_fx_left: 7000 } }]; } });
        var handlerCalls = 0; storageHandlers.push(function () { handlerCalls++; });
        TH.sync.pull(true); await wait(30);
        assert.strictEqual(lstore.tapokhub_fx_right, '44'); assert.strictEqual(lstore.tapokhub_fx_top, '25'); assert.strictEqual(lstore.tapokhub_anim_vcr, 'true');
        assert.strictEqual(lstore.tapokhub_fx_bottom, '8'); assert.strictEqual(lstore.tapokhub_fx_left, '77', 'старый кеш без неподтверждённых изменений заменён серверным значением');
        assert.deepStrictEqual(syncPosts, [], 'старый кеш не отправляется обратно');
        assert.strictEqual(handlerCalls, 0, 'принятые с сервера значения не порождают событий (не отправляем обратно)');
        assert.deepStrictEqual(lstore.tapokhub_settings_meta.tapokhub_fx_right, 3000);
        assert.strictEqual(lstore.tapokhub_settings_meta.tapokhub_fx_left, 900, 'версия серверного значения учтена');
        storageHandlers.pop();
        // не чаще раза в минуту
        var before = libCalls.length; TH.sync.pull(); assert.strictEqual(libCalls.length, before);
        // сервер молчит — локальное на месте
        flow({ 'GET settings': [{ status: 0 }, null] }); TH.sync.pull(true); await wait(10);
        assert.strictEqual(lstore.tapokhub_fx_right, '44');
        TH.proxy.configure(syncBase);
    });

    await test('область помех: страницы открываются кнопками и возвращают «Назад» на страницу выше', function () {
        var byComp = {}; (calls.settingsParams || []).forEach(function (p) { (byComp[p.component] = byComp[p.component] || []).push(p); });
        var opened = [], saved = Lampa.Settings;
        Lampa.Settings = { create: function (n, p) { opened.push([n, p && typeof p.onBack === 'function' ? 'back' : '-']); if (p && p.onBack) p.onBack(); } };
        byComp.tapokhub_anim.filter(function (p) { return p.param.name === 'tapokhub_open_fx'; })[0].onChange();
        byComp.tapokhub_fx.filter(function (p) { return p.param.name === 'tapokhub_open_fx_trap'; })[0].onChange();
        Lampa.Settings = saved;
        assert.deepStrictEqual(opened, [['tapokhub_fx', 'back'], ['tapokhub_anim', '-'], ['tapokhub_fx_trap', 'back'], ['tapokhub_fx', '-']]);
    });

    var base0 = TH.proxy.base();
    var rr = function () { favLists = {}; timeline = {}; viewedIds = []; viewedTv = []; calls.noty = []; };
    await test('«Смотрю сейчас»: сериалы из библиотеки, которые смотрю, — отдельной группой сверху, от недавних, без повторов ниже', async function () {
        rr(); TH.proxy.configure(LB);
        favLists.history = [
            { id: 82856, name: 'Мандалорец', original_name: 'The Mandalorian' },      // смотрел последним
            { id: 999, title: 'Чужой фильм', original_title: 'x' },
            { id: 11, title: 'Новая надежда', original_title: 'ANH' }];                // фильм из истории в «сериалы» не попадёт
        favLists.look = [];
        flow({ 'GET items': [null, myItems()] });
        var s = await openLibrary(); TH.proxy.configure(base0);
        var g = s.sections();
        assert.deepStrictEqual(g.map(function (x) { return x.title; }), ['', 'Смотрю сейчас', 'Мои фильмы'], 'сверху кнопки-фильтры (фильмы и сериалы: групп две)');
        assert.deepStrictEqual(g[1].cards.map(function (c) { return c.id; }), [82856]);
        // просмотренный целиком (отметка) уже не «смотрю»
        rr(); TH.proxy.configure(LB);
        favLists.history = [{ id: 82856, name: 'Мандалорец', original_name: 'The Mandalorian' }]; viewedIds = [82856]; viewedTv = [82856];
        flow({ 'GET items': [null, myItems()] });
        s = await openLibrary(); TH.proxy.configure(base0);
        assert.deepStrictEqual(s.sections().map(function (x) { return x.title; }), ['', 'Мои фильмы', 'Мои сериалы'], 'просмотренный сериал остаётся на своём месте');
        rr();
    });

    await test('«Смотрю сейчас»: коллекции, из которых что-то начато и не всё просмотрено, — сверху, от недавних', async function () {
        rr(); TH.proxy.configure(LB);
        var list = franchiseList();
        list.franchises[0].members = [['movie', 1], ['movie', 2], ['tv', 3]];      // Сага
        list.franchises[3].members = [['movie', 10], ['movie', 20]];               // Без новых
        favLists.history = [{ id: 20, title: 'Вторая', original_title: 'b' }, { id: 1, title: 'Первая', original_title: 'a' }];
        flow({ 'GET franchises': [null, list] });
        var s = await openCollections(); TH.proxy.configure(base0);
        var g = s.sections();
        assert.deepStrictEqual(g.map(function (x) { return x.title; }), ['Смотрю сейчас'], 'обе коллекции смотрю: «остальных» нет');
        assert.deepStrictEqual(g[0].cards.map(function (c) { return c.title; }), ['Без новых', 'Сага'], 'фильм 20 смотрел позже, чем 1: его коллекция выше');
        rr(); TH.proxy.configure(LB);
        favLists.history = [{ id: 20, title: 'Вторая', original_title: 'b' }];
        flow({ 'GET franchises': [null, list] });
        s = await openCollections(); TH.proxy.configure(base0); g = s.sections();
        assert.deepStrictEqual(g.map(function (x) { return x.title; }), ['Смотрю сейчас', 'Остальные коллекции']);
        assert.deepStrictEqual([g[0].cards[0].title, g[1].cards[0].title], ['Без новых', 'Сага']);
        // всё просмотрено — коллекция уходит вниз; ничего не смотрю — один общий список без заголовка
        rr(); TH.proxy.configure(LB);
        favLists.history = [{ id: 10, title: 'a', original_title: 'a' }, { id: 20, title: 'b', original_title: 'b' }]; viewedIds = [10, 20]; viewedTv = [];
        flow({ 'GET franchises': [null, list] });
        s = await openCollections(); TH.proxy.configure(base0);
        assert.deepStrictEqual(s.sections().map(function (x) { return x.title; }), [''], 'все просмотрено и ничего не смотрю: обычный порядок');
        rr(); TH.proxy.configure(LB);
        favLists.look = [{ id: 2, title: 'Отмечен «Смотрю»', original_title: 'c' }];       // отметка Lampa «Смотрю»
        flow({ 'GET franchises': [null, list] });
        s = await openCollections(); TH.proxy.configure(base0);
        assert.deepStrictEqual(s.sections()[0].cards.map(function (c) { return c.title; }), ['Сага'], 'отметка «Смотрю» тоже считается');
        rr();
    });

    await test('анимация: по умолчанию выключена, переключатели есть в настройках плагина', function () {
        assert.strictEqual(TH.anim.counters(), false);
        assert.strictEqual(TH.anim.crt(), false);
        var byName = {}; (calls.settingsParams || []).forEach(function (p) { if (p.param.name) byName[p.param.name] = p; });
        assert.strictEqual(byName.tapokhub_anim_counters.param.type, 'trigger');
        assert.strictEqual(byName.tapokhub_anim_counters.param.default, false);
        assert.strictEqual(byName.tapokhub_anim_crt.param.default, false);
        assert.ok(/с нуля/.test(byName.tapokhub_anim_counters.field.name) && /Помехи/.test(byName.tapokhub_anim_crt.field.name));
        assert.ok((calls.settingsParams || []).some(function (p) { return p.param.type === 'title' && /Анимация/.test(p.field.name); }), 'свой заголовок раздела');
    });

    await test('анимация счётчиков: включена — числа растут от нуля до значений и останавливаются точно на них', async function () {
        var oldMs = TH.anim.countMs; TH.anim.countMs = 120; store.tapokhub_anim_counters = true;
        viewedIds = [11]; viewedTv = [];
        flow({ 'GET stats': [null, { movies: 34, tv: 12, collections: 6, ids: { movie: [11, 5], tv: [] } }] });
        var h = newHome(), root = h.render(true);
        var statsEl = stageEl(root).children[0].children.filter(function (c) { return c.className === 'tapokhub-home__stats'; })[0];
        var nums = function () { return (statsEl.innerHTML.match(/<b>(\d+)<\/b>/g) || []).map(function (x) { return +x.replace(/\D/g, ''); }); };
        var seen = [];
        h.start();
        for (var i = 0; i < 14; i++) { await wait(15); if (nums().length) seen.push(nums()[0]); }
        await wait(120);
        assert.deepStrictEqual(nums(), [34, 12, 6, 1], 'финальные значения точные');
        assert.ok(seen.some(function (n) { return n < 34; }), 'по пути были промежуточные значения: ' + seen.join(','));
        assert.ok(seen.every(function (n, i) { return i === 0 || n >= seen[i - 1]; }), 'числа только растут');
        h.destroy();
        store.tapokhub_anim_counters = false; TH.anim.countMs = oldMs; viewedIds = [];
    });

    await test('анимация счётчиков: ушли с экрана посреди набора — больше не рисуем; выключена — сразу готовые числа', async function () {
        var oldMs = TH.anim.countMs; TH.anim.countMs = 200; store.tapokhub_anim_counters = true;
        flow({ 'GET stats': [null, { movies: 100, tv: 50, collections: 9, ids: { movie: [], tv: [] } }] });
        var h = newHome(), root = h.render(true);
        var statsEl = stageEl(root).children[0].children.filter(function (c) { return c.className === 'tapokhub-home__stats'; })[0];
        h.start(); await wait(40); h.destroy();
        var frozen = statsEl.innerHTML; await wait(250);
        assert.strictEqual(statsEl.innerHTML, frozen, 'после закрытия экрана набор остановился');
        store.tapokhub_anim_counters = false;
        var h2 = newHome(), r2 = h2.render(true);
        var s2 = stageEl(r2).children[0].children.filter(function (c) { return c.className === 'tapokhub-home__stats'; })[0];
        h2.start(); await wait(15);
        assert.ok(/<b>100<\/b>/.test(s2.innerHTML) && /<b>50<\/b>/.test(s2.innerHTML), 'без анимации сразу итог');
        h2.destroy(); TH.anim.countMs = oldMs;
    });

    await test('анимация ЭЛТ: класс tapokhub-crt на главном экране только при включённой настройке; слои помех не ловят касания', function () {
        var h = newHome(); h.start();
        assert.strictEqual(h.render(true).className, 'tapokhub-home', 'по умолчанию помех нет');
        h.destroy();
        store.tapokhub_anim_crt = true;
        var h2 = newHome(); h2.start();
        assert.strictEqual(h2.render(true).className, 'tapokhub-home tapokhub-crt');
        var fxEl = stageEl(h2.render(true)).children[0].children.filter(function (c) { return c.className === 'tapokhub-home__fx'; })[0];
        assert.ok(fxEl, 'область помех внутри «стекла»');
        var kids = fxEl.children.map(function (c) { return c.className; });
        assert.ok(kids.indexOf('tapokhub-home__noise') > -1 && kids.indexOf('tapokhub-home__roll') > -1, 'слои снега и бегущей полосы лежат в области помех');
        h2.destroy(); store.tapokhub_anim_crt = false;
        var css = calls.appended[1].html;
        assert.ok(/\.tapokhub-home__fx\{display:none;position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none/.test(css), 'область помех на всё стекло, форму задаёт clip-path; скрыта и не ловит касания');
        var poly = css.match(/\.tapokhub-home__fx\{[^}]*clip-path:(polygon\([^}]*\))\}/)[1];
        assert.strictEqual(poly, TH.fx.shape(fxShipped), 'по умолчанию форма из боевых значений');
        assert.ok(/50%/.test(poly), 'выгиб сторон по умолчанию есть: у сторон появилась средняя точка');
        assert.ok(/\.tapokhub-crt \.tapokhub-home__fx\{display:block\}/.test(css));
        assert.ok(/@keyframes tapokhub-snow/.test(css) && /@keyframes tapokhub-roll/.test(css) && /@keyframes tapokhub-flicker/.test(css) && /@keyframes tapokhub-glitch/.test(css));
        var anim = css.match(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})+\}/g).join('');
        assert.ok(!/(left|top|width|height|margin|box-shadow|filter)\s*:/.test(anim), 'анимируются только transform и opacity: дёшево для слабых устройств');
        assert.ok(/prefers-reduced-motion/.test(css), 'уважаем системную настройку «меньше движения»');
        assert.ok(/\.tapokhub-home__screen\{[^}]*clip-path:inset\(0 round/.test(css), 'экран обрезает слои помех по закруглённой рамке даже там, где overflow:hidden не справляется');
        assert.ok(TH.anim.countMs >= 3000, 'счётчики набираются неспешно');
    });

    await test('главный экран: сервер не ответил или ответ не тот — сводки нет, экран работает', async function () {
        flow({ 'GET stats': [{ status: 0 }, null] });
        var h = newHome(), root = h.render(true);
        var statsEl = stageEl(root).children[0].children.filter(function (c) { return c.className === 'tapokhub-home__stats'; })[0];
        h.start(); await wait(15);
        assert.strictEqual(statsEl.innerHTML, '');
        flow({ 'GET stats': [null, { oops: 1 }] });
        h.start(); await wait(15);
        assert.strictEqual(statsEl.innerHTML, '');
        h.destroy();
    });

    await test('«Библиотека»: только одиночные фильмы и сериалы, без коллекций, фон карточек не меняется', async function () {
        libCalls.length = 0;
        flow({ 'GET franchises': [null, franchiseList()], 'GET items': [null, myItems()] });
        var s = await openLibrary();
        assert.deepStrictEqual(titles(s), ['', 'Мои фильмы', 'Мои сериалы']);
        var g = s.sections();
        assert.deepStrictEqual(g.map(function (l) { return l.cards.length; }), [3, 2, 1], 'три кнопки («Все», «Фильмы», «Сериалы»), 2 фильма, 1 сериал');
        assert.ok(g.every(function (x) { return x.cards.every(function (c) { return !c.tapokhub_franchise; }); }), 'плиток коллекций нет');
        assert.strictEqual(g[1].cards[0].params.emit.onlyFocus, undefined, 'экран рисует свой фон: кадры фильмов Lampa не меняем');
        assert.strictEqual(g[1].cards[0].params.emit.onlyHover, undefined);
        assert.strictEqual(g[2].cards[0].original_name, 'Мандалорец', 'сериал доведён TH.card');
        assert.strictEqual(libCalls.filter(function (c) { return /franchises$/.test(c.url); }).length, 0, 'список коллекций даже не запрашиваем');
    });

    var groupedItems = function () {
        return { items: [
            { id: 11, media_type: 'movie', group: 'movie', title: 'Новая надежда', poster_path: '/a.jpg' },
            { id: 82856, media_type: 'tv', group: 'tv', name: 'Мандалорец', poster_path: '/m.jpg' },
            { id: 10681, media_type: 'movie', group: 'cartoon_movie', title: 'ВАЛЛ·И', poster_path: '/w.jpg' },
            { id: 456, media_type: 'tv', group: 'cartoon_tv', name: 'Симпсоны', poster_path: '/s.jpg' },
            { id: 129, media_type: 'movie', group: 'anime', title: 'Унесённые призраками', poster_path: '/u.jpg' },
            { id: 31910, media_type: 'tv', group: 'anime', name: 'Наруто', poster_path: '/n.jpg' },
            { id: 500, media_type: 'movie', group: 'docs', title: 'Документалка', poster_path: '/d.jpg' }] };
    };
    var buttonLabels = function (s) { return s.sections()[0].cards.map(function (c) { return c.title; }); };

    await test('«Библиотека»: мультфильмы, мультсериалы, аниме и манга, документальные — отдельными группами; сверху кнопки-фильтры со счётом', async function () {
        rr(); flow({ 'GET items': [null, groupedItems()] });
        var s = await openLibrary();
        assert.deepStrictEqual(titles(s), ['', 'Мои фильмы', 'Мои сериалы', 'Мои мультфильмы', 'Мои мультсериалы', 'Аниме и манга', 'Документальные']);
        assert.deepStrictEqual(s.sections().slice(1).map(function (l) { return l.cards.map(function (c) { return c.id; }); }), [[11], [82856], [10681], [456], [129, 31910], [500]], 'аниме: и фильм, и сериал вместе');
        assert.deepStrictEqual(buttonLabels(s), ['Все · 7', 'Фильмы · 1', 'Сериалы · 1', 'Мультфильмы · 1', 'Мультсериалы · 1', 'Аниме и манга · 2', 'Документальные · 1']);
    });

    await test('«Библиотека»: кнопка-фильтр заменяет экран с выбранной группой; выбранная подсвечена; «Все» возвращает всё', async function () {
        rr(); flow({ 'GET items': [null, groupedItems()] });
        var s = await openLibrary();
        var buttons = s.sections()[0].cards;
        calls.replaced = [];
        buttons[5].params.emit.onlyEnter();
        assert.deepStrictEqual(calls.replaced, [{ group: 'anime' }], 'Activity.replace, а не новый экран в стеке');
        buttons[0].params.emit.onlyEnter();
        assert.deepStrictEqual(calls.replaced[1], { group: '' });
        var on = function (btn) { var h = jq(); btn.params.emit.onCreate.call({ html: h }); return !!h.classes['tapokhub-action--on']; };
        assert.ok(on(buttons[0]) && !on(buttons[5]), 'без фильтра подсвечено «Все»');
        // открытие экрана с фильтром
        flow({ 'GET items': [null, groupedItems()] });
        var f = calls.components.tapokhub_library({ group: 'anime' }); f.fire('create'); await wait(25);
        assert.deepStrictEqual(titles(f), ['', 'Аниме и манга'], 'только выбранная группа, без «Смотрю сейчас»');
        assert.deepStrictEqual(f.sections()[1].cards.map(function (c) { return c.id; }), [129, 31910]);
        assert.strictEqual(buttonLabels(f).length, 7, 'кнопки остаются, чтобы переключить группу');
        assert.ok(on(f.sections()[0].cards[5]) && !on(f.sections()[0].cards[0]), 'подсвечена выбранная группа');
        assert.strictEqual(f.last.data.id, 129, 'стартовый фокус на первой карточке, а не на кнопке');
    });

    await test('«Библиотека»: группа одна — кнопок нет; фильтр опустевшей или неизвестной группы показывает всё; ответ без групп (старый сервер) делит по виду', async function () {
        rr(); flow({ 'GET items': [null, { items: [{ id: 11, media_type: 'movie', group: 'movie', title: 'Один', poster_path: '/a.jpg' }] }] });
        var one = await openLibrary();
        assert.deepStrictEqual(titles(one), ['Мои фильмы'], 'без кнопок: одна группа');
        flow({ 'GET items': [null, groupedItems()] });
        var gone = calls.components.tapokhub_library({ group: 'nonexistent' }); gone.fire('create'); await wait(25);
        assert.deepStrictEqual(titles(gone), ['', 'Мои фильмы', 'Мои сериалы', 'Мои мультфильмы', 'Мои мультсериалы', 'Аниме и манга', 'Документальные'], 'неизвестная группа: показываем всё');
        flow({ 'GET items': [null, myItems()] });
        var old = await openLibrary();
        assert.deepStrictEqual(titles(old), ['', 'Мои фильмы', 'Мои сериалы'], 'поле group отсутствует: фильмы и сериалы по виду');
    });

    await test('размытый фон хаба: «Библиотека» и «Коллекции» включают слой на start, выключают на pause и destroy', async function () {
        TH.backdrop.hide(TH.backdrop.owner());   // главный экран из прошлых проверок мог оставить слой
        for (var name of ['tapokhub_library', 'tapokhub_collections']) {
            flow({ 'GET franchises': [null, franchiseList()], 'GET items': [null, myItems()] });
            var s = calls.components[name]({}); s.fire('create'); await wait(25);
            assert.strictEqual(TH.backdrop.owner(), null, 'до start слоя нет');
            s.fire('start');
            assert.ok(TH.backdrop.owner(), name + ': слой включён');
            s.fire('pause');
            assert.strictEqual(TH.backdrop.owner(), null, name + ': на pause выключен, иначе закрыл бы страницу фильма');
            s.fire('start'); s.fire('destroy');
            assert.strictEqual(TH.backdrop.owner(), null, name + ': на destroy выключен');
        }
    });

    await test('слой фона: чужой hide не выключает слой, занятый другим экраном', function () {
        var a = {}, b = {};
        TH.backdrop.show(a, 'dark'); TH.backdrop.show(b, 'blur');
        TH.backdrop.hide(a);
        assert.strictEqual(TH.backdrop.owner(), b, 'слой уже у нового экрана');
        TH.backdrop.hide(b);
        assert.strictEqual(TH.backdrop.owner(), null);
    });

    await test('экран франшизы держит фильмовый фон: слой не включает, карточки меняют фон Lampa', async function () {
        flow({ 'GET franchises/7': [null, franchiseDetail()] });
        var s = calls.components.tapokhub_franchise({ franchise_id: 7 }); s.fire('create'); await wait(15); s.fire('start');
        assert.strictEqual(TH.backdrop.owner(), null);
        assert.strictEqual(typeof s.built.results[1].params.emit.onlyFocus, 'function');
    });

    await test('плитка: название заменяется логотипом франшизы; картинка не загрузилась или логотипа нет — остаётся текст', async function () {
        flow({ 'GET franchises': [null, { franchises: [summary({ id: 7, title: 'Сага', logo: '/saga_logo.png', cover: { backdrop_path: '/bd7.jpg' } }), summary({ id: 10, title: 'Без логотипа', cover: { backdrop_path: '/x.jpg' } })] }] });
        var s = await openCollections();
        var mk = function () { var title = makeEl('div'); title.textContent = 'Сага'; title.parentNode = makeEl('div'); var html = makeEl('div'); html.addClass = function () {}; html.find = function () { return title; }; return { html: html, title: title }; };
        var withLogo = mk(); s.built.results[0].params.emit.onCreate.call(withLogo);
        await wait(10);
        assert.strictEqual(withLogo.title.children[0].src, 'img:w500/saga_logo.png');
        assert.strictEqual(withLogo.title.children[0].className, 'tapokhub-logo');
        assert.strictEqual(withLogo.title.children[0].alt, 'Сага');
        var without = mk(); s.built.results[1].params.emit.onCreate.call(without);
        await wait(10);
        assert.strictEqual(without.title.children.length, 0, 'логотипа нет — текст на месте');
        imageMode = 'error';
        var broken = mk(); s.built.results[0].params.emit.onCreate.call(broken);
        await wait(10); imageMode = 'ok';
        assert.strictEqual(broken.title.children.length, 0, 'картинка не загрузилась — текст на месте');
    });

    await test('удаление коллекции: из настроек — список всех коллекций (и собираемых), выбор, подтверждение, удаление', async function () {
        var base0 = TH.proxy.base(); TH.proxy.configure(LB);
        var byName = {}; (calls.settingsParams || []).forEach(function (p) { if (p.component === 'tapokhub' && p.param.name) byName[p.param.name] = p; });
        var deleted = [];
        flow({ 'GET franchises': [null, franchiseList()], 'POST franchises/10/delete': function () { deleted.push(10); return [null, {}]; }, 'POST franchises/8/delete': function () { deleted.push(8); return [null, {}]; } });
        calls.select = null; calls.noty = [];
        byName.tapokhub_delete_collection.onChange(); await wait(20);
        assert.strictEqual(calls.select.title, 'Какую коллекцию удалить?');
        var titles = calls.select.items.map(function (i) { return i.title; });
        assert.deepStrictEqual(titles, ['Сага · 11 позиций', 'Собирается · собирается', 'Без новых · 3 позиции'], 'собираемая тоже видна, слитая не показана');
        calls.select.onSelect(calls.select.items[2]);
        assert.ok(/Удалить коллекцию «Без новых»\?/.test(calls.select.title));
        calls.select.onSelect(calls.select.items[0]); await wait(20);
        assert.deepStrictEqual(deleted, [10]);
        assert.ok(calls.noty.some(function (n) { return /Коллекция «Без новых» удалена/.test(n); }));
        // зависшая «собирается» тоже удаляется
        calls.select = null; byName.tapokhub_delete_collection.onChange(); await wait(20);
        calls.select.onSelect(calls.select.items[1]); calls.select.onSelect(calls.select.items[0]); await wait(20);
        assert.deepStrictEqual(deleted, [10, 8]);
        // коллекций нет / список недоступен
        flow({ 'GET franchises': [null, { franchises: [] }] }); calls.noty = []; byName.tapokhub_delete_collection.onChange(); await wait(20);
        assert.deepStrictEqual(calls.noty, ['Коллекций нет']);
        flow({ 'GET franchises': [{ status: 0 }, null] }); calls.noty = []; byName.tapokhub_delete_collection.onChange(); await wait(20);
        assert.deepStrictEqual(calls.noty, ['Список коллекций недоступен']);
        TH.proxy.configure(base0);
    });

    await test('плитка коллекции: нативный стиль «collection», кадр, открытие франшизы, метка NEW', async function () {
        flow({ 'GET franchises': [null, franchiseList()] });
        var s = await openCollections();
        var tile = s.built.results[0], plain = s.built.results[1];
        assert.deepStrictEqual([tile.title, tile.backdrop_path, tile.params.style.name, tile.tapokhub_franchise], ['Сага', '/bd7.jpg', 'collection', 7]);
        assert.ok(tile.id > 800000000, 'id вне диапазона TMDB');
        assert.strictEqual(plain.backdrop_path, '/pp10.jpg', 'нет кадра — берём постер');
        var n = calls.activity.length; tile.params.emit.onlyEnter();
        var a = calls.activity[n];
        assert.deepStrictEqual([a.component, a.franchise_id, a.title], ['tapokhub_franchise', 7, 'Сага']);
        var node = { html: makeEl('div') }; node.html.addClass = function (c) { this.classes = (this.classes || []).concat(c); };
        tile.params.emit.onCreate.call(node); plain.params.emit.onCreate.call({ html: (function () { var h = makeEl('div'); h.addClass = function (c) { this.classes = (this.classes || []).concat(c); }; return h; })() });
        assert.deepStrictEqual(node.html.classes, ['tapokhub-tile', 'tapokhub-tile--new']);
        assert.strictEqual(TH.proxy.enabled(), true);
        assert.strictEqual(Lampa.TMDB.image('t/p/w500//bd7.jpg').indexOf(LB + '/img/'), 0, 'кадр плитки идёт с нашего сервера');
    });

    await test('«Библиотека»: пусто и сервер недоступен или молчит — пустой экран; коллекции без позиций тоже пусто', async function () {
        flow({ 'GET franchises': [null, franchiseList()], 'GET items': [null, { items: [] }] });
        var empty = await openLibrary(); assert.ok(empty.emptied && !empty.built, 'одни коллекции без одиночных позиций: библиотека пуста');
        flow({ 'GET items': [{ status: 0 }, null] });
        var down = await openLibrary(); assert.ok(down.emptied && !down.built, 'сервер недоступен: пустой экран, без исключений');
        TH.lib.mineTimeout = 30;
        flow({ 'GET items': function () { return null; } });   // items молчит
        var slow = calls.components.tapokhub_library({}); slow.fire('create'); await wait(90);
        assert.ok(slow.emptied, 'молчащий сервер не держит экран');
        TH.lib.mineTimeout = 4000;
    });

    await test('«Библиотека»: закрыли до ответа — ничего не строится', async function () {
        flow({ 'GET franchises': [null, franchiseList()], 'GET items': [null, myItems()] });
        var s = calls.components.tapokhub_library({}); s.fire('create'); s.fire('destroy'); await wait(25);
        assert.ok(!s.built && !s.emptied);
    });

    await test('«Коллекции»: только мои коллекции с сервера, плитками на весь экран, готовых из плагина нет', async function () {
        flow({ 'GET franchises': [null, franchiseList()] });
        var s = await openCollections();
        assert.strictEqual(s.sections().length, 1);
        assert.strictEqual(s.sections()[0].title, '', 'заголовка нет: экран и так «Коллекции»');
        assert.deepStrictEqual(s.sections()[0].cards.map(function (c) { return c.title; }), ['Сага', 'Без новых']);
        assert.ok(s.sections()[0].cards.every(function (c) { return c.params.style.name === 'collection'; }));
    });

    await test('«Коллекции»: сервер недоступен, молчит или коллекций нет — пустой экран', async function () {
        flow({ 'GET franchises': [{ status: 0 }, null] });
        assert.ok((await openCollections()).emptied);
        TH.lib.mineTimeout = 30;
        flow({ 'GET franchises': function () { return null; } });
        assert.ok((await openCollections(120)).emptied, 'молчащий сервер: не висим');
        TH.lib.mineTimeout = 4000;
        flow({ 'GET franchises': [null, { franchises: [] }] });
        var s = await openCollections();
        assert.ok(s.emptied && !s.built);
    });

    await test('«Коллекции»: закрыли до ответа — ничего не строится', async function () {
        flow({ 'GET franchises': [null, franchiseList()] });
        var s = calls.components.tapokhub_collections({}); s.fire('create'); s.fire('destroy'); await wait(60);
        assert.ok(!s.built && !s.emptied);
    });

    await test('«Мои…»: без адреса сервера ничего не запрашивается', function () {
        var before = libCalls.length, got = null;
        TH.proxy.configure('');
        TH.lib.loadCollections(function (l) { got = l; });
        assert.deepStrictEqual(got, []);
        var got2 = null; TH.lib.loadItems(function (l) { got2 = l; });
        assert.deepStrictEqual(got2, []);
        assert.strictEqual(libCalls.length, before);
        TH.proxy.configure(LB);
    });

    /* ---------- автозапуск выбранного ранее торрента ---------- */

    var tor = { starts: [], opens: [], hashCalls: [], files: [], drops: [], loading: [], stops: 0, connectedOk: true, hashAnswer: 'ok', filesAnswer: 'ready', pushed: [] };
    var movieA = { id: 550, title: 'Бойцовский клуб', original_title: 'Fight Club', poster_path: '/p.jpg' };
    var seriesA = { id: 1396, name: 'Во все тяжкие', original_name: 'Breaking Bad', first_air_date: '2008-01-20' };
    var torrA = { Title: 'Fight.Club.1999.1080p', title: 'Fight.Club.1999.1080p', MagnetUri: 'magnet:?xt=urn:btih:AAA', Tracker: 'rutor', poster: '/p.jpg' };
    var resetTor = function () {
        tor.starts.length = 0; tor.opens.length = 0; tor.hashCalls.length = 0; tor.files.length = 0; tor.drops.length = 0; tor.loading.length = 0; tor.stops = 0; tor.pushed.length = 0;
        tor.connectedOk = true; tor.hashAnswer = 'ok'; tor.filesAnswer = 'ready'; tor.url = 'ts.example:8090'; tor.android = false;
        lstore = {}; calls.noty = []; calls.activity.length = 0;
        delete store.tapokhub_play_auto; delete store.tapokhub_play_fallback; delete store.tapokhub_play_press; delete store.tapokhub_open_direct; delete store.parse_lang; calls.routed = null;
        TH.play.timing.wait = 120; TH.play.timing.every = 20; TH.play.timing.press = 30;
    };
    Lampa.Torrent = { start: function (e, m) { tor.starts.push([e, m]); }, open: function (h, m) { tor.opens.push([h, m]); } };
    Lampa.Torserver = {
        url: function () { return tor.url; },
        connected: function (ok, fail) { setTimeout(function () { tor.connectedOk ? ok({}) : fail('down'); }, 0); },
        hash: function (o, ok, fail) { tor.hashCalls.push(o); setTimeout(function () { tor.hashAnswer === 'ok' ? ok({ hash: 'HASH1' }) : fail('no hash'); }, 0); },
        files: function (h, ok) { tor.files.push(h); setTimeout(function () { if (tor.filesAnswer === 'ready') ok({ file_stats: [{ id: 1, path: 'a.mkv' }] }); else ok({}); }, 0); },
        drop: function (h) { tor.drops.push(h); }
    };
    Lampa.Loading = { start: function (cancel, text) { tor.loading.push({ cancel: cancel, text: text }); }, stop: function () { tor.stops++; } };
    Lampa.Platform = { is: function (n) { return n === 'android' && tor.android; } };
    var nativePush = Lampa.Activity.push;
    TH.play.install();
    var torrentsScreen = function (movie, extra) { return Object.assign({ url: '', title: 'Торренты', component: 'torrents', search: 'q', movie: movie, page: 1 }, extra || {}); };

    await test('уведомление о запуске торрента: сверху под шапкой, а не внизу; без страницы — штатное Noty', function () {
        resetTor();
        TH.toast('раз'); assert.deepStrictEqual(calls.noty, ['раз'], 'без страницы остаётся штатное уведомление Lampa');
        var savedBody = document.body, made = [];
        document.body = { appendChild: function (el) { made.push(el); } };
        try {
            TH.toast.el = null;
            TH.toast('запускаю выбранный ранее торрент');
            assert.strictEqual(made.length, 1, 'один элемент на всё время');
            assert.strictEqual(made[0].textContent, 'запускаю выбранный ранее торрент');
            assert.strictEqual(made[0].className, 'tapokhub-toast is-on');
            TH.toast('второе'); assert.strictEqual(made.length, 1); assert.strictEqual(made[0].textContent, 'второе');
            assert.deepStrictEqual(calls.noty, ['раз'], 'внизу ничего нового не появилось');
        } finally { document.body = savedBody; TH.toast.el = null; clearTimeout(TH.toast.timer); }
        var css = calls.appended[0].html;
        var rule = css.match(/\.tapokhub-toast\{[^}]*\}/)[0];
        assert.ok(/position:fixed/.test(rule) && /top:calc\(env\(safe-area-inset-top,0px\) \+ 4\.4em\)/.test(rule) && /pointer-events:none/.test(rule), 'сверху под шапкой, с учётом выреза телефона, не ловит касания');
        assert.ok(!/bottom:/.test(rule));
    });

    await test('автозапуск: выбранный торрент запоминается при запуске (по фильму и по сериалу), без ссылки или без id фильма — нет', function () {
        resetTor();
        Lampa.Torrent.start(torrA, movieA);
        Lampa.Torrent.start({ Title: 'Series.S01', MagnetUri: 'magnet:?xt=urn:btih:BBB' }, seriesA);
        Lampa.Torrent.start({ Title: 'no link' }, movieA);
        Lampa.Torrent.start(torrA, { title: 'без id' });
        assert.strictEqual(tor.starts.length, 4, 'штатный запуск торрента продолжается всегда');
        var map = lstore[TH.play.storageKey()];
        assert.deepStrictEqual(Object.keys(map).sort(), ['movie:550', 'tv:1396']);
        assert.strictEqual(map['movie:550'].MagnetUri, 'magnet:?xt=urn:btih:AAA');
        assert.strictEqual(map['movie:550'].title, 'Fight.Club.1999.1080p');
        assert.strictEqual(map['tv:1396'].title, 'Series.S01');
        assert.strictEqual(TH.play.saved(movieA).tracker, 'rutor');
        assert.strictEqual(TH.play.saved({ id: 1 }), null);
    });

    await test('сервер запоминает выбранные торренты: выбор уходит на сервер, забыть очищает и там', async function () {
        resetTor(); var saved0 = TH.proxy.base(); TH.proxy.configure(LB);
        var sent = []; flow({ 'POST torrents': function (body) { sent.push(body); return [null, {}]; }, 'POST torrents/forget': function (body) { sent.push(['forget', body]); return [null, { deleted: 1 }]; } });
        Lampa.Torrent.start(torrA, movieA); await wait(10);
        assert.deepStrictEqual(sent[0], { kind: 'movie', id: 550, title: 'Fight.Club.1999.1080p', MagnetUri: 'magnet:?xt=urn:btih:AAA', Link: '', poster: '/p.jpg', tracker: 'rutor' });
        Lampa.Torrent.start({ Title: 'S', title: 'S', MagnetUri: 'm2' }, seriesA); await wait(10);
        assert.strictEqual(sent[1].kind, 'tv'); assert.strictEqual(sent[1].id, 1396);
        TH.play.forget(); await wait(10);
        assert.deepStrictEqual(sent[2], ['forget', { all: true }]);
        TH.proxy.configure(''); sent.length = 0;
        Lampa.Torrent.start(torrA, movieA);
        assert.deepStrictEqual(sent, [], 'без входа на сервер не ходим, выбор остаётся на устройстве');
        assert.ok(TH.play.saved(movieA), 'и локально сохранён');
        TH.proxy.configure(saved0);
    });

    await test('сервер запоминает выбранные торренты: со сверкой устройство берёт чужое новое и отправляет своё, чего нет на сервере', async function () {
        resetTor(); var saved0 = TH.proxy.base(); TH.proxy.configure(LB);
        lstore[TH.play.storageKey()] = {
            'movie:1': { title: 'local only', MagnetUri: 'mL', at: 1000, dirty: true },
            'movie:2': { title: 'local older', MagnetUri: 'mOld', at: 1000 },
            'movie:3': { title: 'local newer', MagnetUri: 'mNew', at: 9000, dirty: true }
        };
        var uploaded = [];
        flow({
            'GET torrents': [null, { items: [
                { kind: 'movie', id: 2, title: 'remote newer', MagnetUri: 'mRemote2', Link: '', poster: '', tracker: 'x', at: 5000 },
                { kind: 'tv', id: 9, title: 'remote only', MagnetUri: 'mRemote9', Link: '', poster: '', tracker: '', at: 4000 },
                { kind: 'movie', id: 3, title: 'remote older', MagnetUri: 'mR3', Link: '', poster: '', tracker: '', at: 2000 }] }],
            'POST torrents': function (body) { uploaded.push(body.kind + ':' + body.id); return [null, {}]; }
        });
        TH.play.sync(true); await wait(20);
        var map = lstore[TH.play.storageKey()];
        assert.strictEqual(map['movie:2'].MagnetUri, 'mRemote2', 'на сервере новее: взяли');
        assert.strictEqual(map['tv:9'].title, 'remote only', 'выбор с другого устройства появился здесь');
        assert.strictEqual(map['movie:3'].MagnetUri, 'mNew', 'у нас новее: оставили');
        assert.deepStrictEqual(uploaded.sort(), ['movie:1', 'movie:3'], 'на сервер ушло только то, чего там нет или что у нас новее');
        // не чаще раза в минуту
        var before = libCalls.length; TH.play.sync(); assert.strictEqual(libCalls.length, before, 'частые вызовы не дёргают сервер');
        // сервер не ответил: локальное остаётся
        flow({ 'GET torrents': [{ status: 0 }, null] }); TH.play.sync(true); await wait(10);
        assert.strictEqual(lstore[TH.play.storageKey()]['movie:1'].MagnetUri, 'mL');
        TH.proxy.configure(saved0);
    });

    await test('автозапуск: торрент не выбирали или настройка выключена — экран «Торренты» открывается как обычно', function () {
        resetTor();
        Lampa.Activity.push(torrentsScreen(movieA));
        assert.strictEqual(calls.activity.length, 1, 'ничего не выбирали: обычный список парсера');
        Lampa.Torrent.start(torrA, movieA); calls.activity.length = 0;
        store.tapokhub_play_auto = false;
        Lampa.Activity.push(torrentsScreen(movieA));
        assert.strictEqual(calls.activity.length, 1, 'автозапуск выключен');
        assert.strictEqual(tor.loading.length, 0);
        store.tapokhub_play_auto = true; tor.url = '';
        Lampa.Activity.push(torrentsScreen(movieA));
        assert.strictEqual(calls.activity.length, 2, 'TorrServer не задан: проверить нечем, обычный список');
        tor.url = 'ts.example:8090';
        Lampa.Activity.push(torrentsScreen(movieA, { tapokhub_skip: true }));
        assert.strictEqual(calls.activity.length, 3, 'помеченный «пропустить» открывается штатно');
        Lampa.Activity.push({ component: 'main', movie: movieA });
        assert.strictEqual(calls.activity.length, 4, 'другие экраны не трогаем');
    });

    await test('автозапуск: выбирали раньше — список парсера не открывается, торрент добавляется в TorrServer, файлы получены -> Torrent.open', async function () {
        resetTor(); Lampa.Torrent.start(torrA, movieA); calls.activity.length = 0; calls.noty = [];
        Lampa.Activity.push(torrentsScreen(movieA));
        await wait(80);
        assert.strictEqual(calls.activity.length, 0, 'список парсера не открывали');
        assert.strictEqual(tor.loading.length, 1, 'экран ожидания');
        assert.strictEqual(tor.hashCalls[0].link, 'magnet:?xt=urn:btih:AAA');
        assert.strictEqual(tor.hashCalls[0].data.movie.id, 550);
        assert.deepStrictEqual(tor.opens, [['HASH1', movieA]], 'дальше файлы показывает сама Lampa');
        assert.strictEqual(tor.stops, 1, 'ожидание закрыто');
        assert.ok(/запускаю выбранный ранее торрент/.test(tor.loading[0].text) && /Назад/.test(tor.loading[0].text), 'сообщение на экране ожидания, с подсказкой про «Назад»');
        assert.deepStrictEqual(calls.noty, [], 'тост с тем же текстом не дублирует экран ожидания');
        assert.strictEqual(tor.starts.length, 1, 'Torrent.start заново не вызывали (только сам выбор ранее)');
    });

    await test('автозапуск: повторный Enter во время запуска не запускает торрент второй раз, после завершения запускается снова', async function () {
        resetTor(); Lampa.Torrent.start(torrA, movieA); calls.activity.length = 0;
        Lampa.Activity.push(torrentsScreen(movieA));
        Lampa.Activity.push(torrentsScreen(movieA));       // двойное нажатие / два события на один Enter
        await wait(80);
        assert.strictEqual(tor.loading.length, 1, 'экран ожидания один');
        assert.strictEqual(tor.hashCalls.length, 1, 'в TorrServer торрент добавлен один раз');
        assert.strictEqual(tor.opens.length, 1, 'файлы открыты один раз');
        assert.strictEqual(calls.activity.length, 0);
        Lampa.Activity.push(torrentsScreen(movieA)); await wait(80);
        assert.strictEqual(tor.hashCalls.length, 2, 'после завершения запуск снова возможен');
    });

    await test('автозапуск: торрент недоступен (нет файлов за отведённое время) — торрент сброшен, открыт поиск по парсеру с теми же параметрами', async function () {
        resetTor(); Lampa.Torrent.start(torrA, movieA); calls.activity.length = 0; calls.noty = [];
        tor.filesAnswer = 'none';
        Lampa.Activity.push(torrentsScreen(movieA, { search: 'fight club', search_one: 'Бойцовский клуб' }));
        await wait(260);
        assert.deepStrictEqual(tor.drops, ['HASH1'], 'мёртвый торрент убран из TorrServer');
        assert.strictEqual(tor.opens.length, 0);
        assert.strictEqual(calls.activity.length, 1);
        var a = calls.activity[0];
        assert.strictEqual(a.component, 'torrents'); assert.strictEqual(a.tapokhub_skip, true, 'второй раз не перехватываем: иначе зациклились бы');
        assert.strictEqual(a.search, 'fight club'); assert.strictEqual(a.search_one, 'Бойцовский клуб'); assert.strictEqual(a.movie, movieA);
        assert.ok(calls.noty.some(function (n) { return /недоступен, ищу другие через парсер/.test(n); }));
        assert.ok(tor.stops >= 1);
    });

    await test('автозапуск: TorrServer не дал хэш — то же: ищем другие; при выключенной настройке только сообщение', async function () {
        resetTor(); Lampa.Torrent.start(torrA, movieA); calls.activity.length = 0;
        tor.hashAnswer = 'fail';
        Lampa.Activity.push(torrentsScreen(movieA)); await wait(40);
        assert.strictEqual(calls.activity.length, 1); assert.strictEqual(calls.activity[0].tapokhub_skip, true);
        resetTor(); Lampa.Torrent.start(torrA, movieA); calls.activity.length = 0; calls.noty = [];
        tor.hashAnswer = 'fail'; store.tapokhub_play_fallback = false;
        Lampa.Activity.push(torrentsScreen(movieA)); await wait(40);
        assert.strictEqual(calls.activity.length, 0, 'поиск по парсеру выключен: список не открываем');
        assert.ok(calls.noty.some(function (n) { return /выбранный торрент недоступен/.test(n); }));
        assert.ok(tor.stops >= 1, 'ожидание закрыто');
    });

    await test('автозапуск: TorrServer не отвечает — не вина торрента, штатный запуск Lampa со своей ошибкой (без списка парсера)', async function () {
        resetTor(); Lampa.Torrent.start(torrA, movieA); calls.activity.length = 0; tor.starts.length = 0;
        tor.connectedOk = false;
        Lampa.Activity.push(torrentsScreen(movieA)); await wait(30);
        assert.strictEqual(calls.activity.length, 0);
        assert.strictEqual(tor.starts.length, 1);
        assert.strictEqual(tor.starts[0][0].MagnetUri, 'magnet:?xt=urn:btih:AAA');
        assert.strictEqual(tor.starts[0][1], movieA);
    });

    await test('автозапуск: «Назад» на экране ожидания открывает список парсера — выбрать другой торрент', async function () {
        resetTor(); Lampa.Torrent.start(torrA, movieA); calls.activity.length = 0;
        tor.filesAnswer = 'none';
        Lampa.Activity.push(torrentsScreen(movieA)); await wait(10);
        tor.loading[0].cancel();
        assert.strictEqual(calls.activity.length, 1); assert.strictEqual(calls.activity[0].tapokhub_skip, true);
        await wait(200);
        assert.strictEqual(calls.activity.length, 1, 'после отмены запуск не продолжается и список второй раз не открывается');
        assert.strictEqual(tor.opens.length, 0);
    });

    await test('автозапуск: андроид-клиент управляет торрентами сам — сразу штатный запуск', function () {
        resetTor(); Lampa.Torrent.start(torrA, movieA); calls.activity.length = 0; tor.starts.length = 0;
        tor.android = true; tor.url = '';
        Lampa.Activity.push(torrentsScreen(movieA));
        assert.strictEqual(calls.activity.length, 0);
        assert.strictEqual(tor.starts.length, 1);
        assert.strictEqual(tor.loading.length, 0, 'ожидания нет: клиент сам покажет процесс');
    });

    await test('автозапуск: сразу запускается нужный файл — последний просмотренный, следующий после досмотренного, иначе первый', async function () {
        var run = async function (percents) {
            resetTor(); Lampa.Torrent.start(torrA, seriesA); calls.activity.length = 0;
            var pressed = [];
            Lampa.Activity.push(torrentsScreen(seriesA)); await wait(60);
            var fire = function (e) { torrentFileHandlers.forEach(function (h) { h(e); }); };
            fire({ type: 'list_open' });
            percents.forEach(function (p, i) { fire({ type: 'render', element: { timeline: { percent: p } }, item: { trigger: function (ev) { pressed.push([i, ev]); } } }); });
            await wait(70);
            return pressed;
        };
        assert.deepStrictEqual(await run([100, 100, 40, 0]), [[2, 'hover:enter']], 'остановились на третьей серии');
        assert.deepStrictEqual(await run([100, 95, 0, 0]), [[2, 'hover:enter']], 'вторая почти досмотрена: следующая');
        assert.deepStrictEqual(await run([0, 0, 0]), [[0, 'hover:enter']], 'ничего не смотрели: первый файл');
        assert.deepStrictEqual(await run([100, 100]), [], 'досмотрено всё: следующего нет, остаёмся на последней');
    });

    await test('автозапуск: без выбранного торрента и при выключенной настройке файлы сами не запускаются', async function () {
        resetTor(); Lampa.Torrent.start(torrA, seriesA); store.tapokhub_play_press = false;
        var pressed = 0;
        Lampa.Activity.push(torrentsScreen(seriesA)); await wait(60);
        torrentFileHandlers.forEach(function (h) { h({ type: 'list_open' }); h({ type: 'render', element: { timeline: { percent: 0 } }, item: { trigger: function () { pressed++; } } }); });
        await wait(70);
        assert.strictEqual(pressed, 0);
        // список файлов, который открыл человек сам, без нашего запуска, не трогаем
        resetTor();
        torrentFileHandlers.forEach(function (h) { h({ type: 'list_open' }); h({ type: 'render', element: { timeline: { percent: 0 } }, item: { trigger: function () { pressed++; } } }); });
        await wait(70);
        assert.strictEqual(pressed, 0);
    });

    await test('версия Lampa: плагин запускается с 3.0.5 (app_digital 305), на более старой — нет', function () {
        var was = Lampa.Manifest.app_digital;
        try {
            Lampa.Manifest.app_digital = 305; assert.strictEqual(TH.supported(), true, '3.0.5');
            Lampa.Manifest.app_digital = 334; assert.strictEqual(TH.supported(), true, '3.3.4');
            Lampa.Manifest.app_digital = 304; assert.strictEqual(TH.supported(), false, '3.0.4 не поддерживается');
        } finally { Lampa.Manifest.app_digital = was; }
    });

    var fakeMenu = function (names) {
        var list = { children: [], insertBefore: function (el, ref) { var i = this.children.indexOf(el); if (i > -1) this.children.splice(i, 1); this.children.splice(this.children.indexOf(ref), 0, el); } };
        names.concat(['TapokHub']).forEach(function (n) { list.children.push({ className: 'menu__item selector', name: n, parentNode: list }); });
        list.order = function () { return list.children.map(function (c) { return c.name; }); };
        return list;
    };
    var menuNames = ['Главная', 'Фильмы', 'Сериалы', 'Избранное', 'История'];

    await test('пункт меню TapokHub — третий: первый запуск, порядок ещё не сохранён (его запомнит редактор меню Lampa)', function () {
        lstore = {};
        var list = fakeMenu(menuNames), el = list.children[5];
        TH.placeMenuButton(el);
        assert.deepStrictEqual(list.order(), ['Главная', 'Фильмы', 'TapokHub', 'Сериалы', 'Избранное', 'История']);
        assert.strictEqual(lstore.menu_sort, undefined, 'пустой порядок не создаём: редактор снимет его с экрана, где пункт уже третий');
        assert.ok(lstore.tapokhub_menu_placed);
    });

    await test('пункт меню TapokHub — третий: порядок уже сохранён (иначе редактор меню вернул бы пункт в конец); jQuery-объект тоже подходит', function () {
        lstore = { menu_sort: ['Главная', 'Фильмы', 'Сериалы', 'Избранное', 'История', 'TapokHub'] };
        var list = fakeMenu(menuNames), el = list.children[5];
        TH.placeMenuButton([el]);   // Lampa.Menu.addButton возвращает jQuery: сам элемент в [0]
        assert.deepStrictEqual(list.order(), ['Главная', 'Фильмы', 'TapokHub', 'Сериалы', 'Избранное', 'История']);
        assert.deepStrictEqual(lstore.menu_sort, ['Главная', 'Фильмы', 'TapokHub', 'Сериалы', 'Избранное', 'История'], 'без дублей');
        lstore = { menu_sort: ['Главная'] };
        TH.placeMenuButton(fakeMenu(menuNames).children[5]);
        assert.deepStrictEqual(lstore.menu_sort, ['Главная', 'TapokHub'], 'порядок короче трёх пунктов: в конец');
    });

    await test('пункт меню TapokHub: один раз; дальше выбор пользователя в редакторе меню не сбрасывается', function () {
        lstore = { tapokhub_menu_placed: 'v1', menu_sort: ['TapokHub', 'Главная', 'Фильмы'] };
        var list = fakeMenu(menuNames), el = list.children[5];
        TH.placeMenuButton(el);
        assert.deepStrictEqual(list.order().slice(-1), ['TapokHub'], 'DOM не трогаем');
        assert.deepStrictEqual(lstore.menu_sort, ['TapokHub', 'Главная', 'Фильмы'], 'порядок пользователя сохранён');
    });

    await test('пункт меню TapokHub: нет элемента или короткое меню — без исключений', function () {
        lstore = {};
        TH.placeMenuButton(undefined);
        lstore = {};
        var list = fakeMenu(['Главная']);
        TH.placeMenuButton(list.children[1]);
        assert.deepStrictEqual(list.order(), ['Главная', 'TapokHub'], 'меньше трёх пунктов: остаётся в конце');
    });

    await test('«Открывать фильм сразу через торрент»: выключено (по умолчанию) — Enter открывает страницу фильма, как раньше', function () {
        resetTor(); store.parser_use = true;
        var card = TH.card(movieA, 'movie');
        card.params.emit.onlyEnter();
        assert.strictEqual(calls.routed[0], 'full'); assert.strictEqual(calls.routed[1], card);
        assert.strictEqual(calls.activity.length, 0);
        var byName = {}; (calls.settingsParams || []).forEach(function (p) { if (p.component === 'tapokhub_play') byName[p.param.name] = p; });
        assert.strictEqual(byName.tapokhub_open_direct.param.type, 'trigger'); assert.strictEqual(byName.tapokhub_open_direct.param.default, false, 'новое поведение включает сам пользователь');
    });

    await test('«Открывать фильм сразу через торрент»: торрент не выбирали — сразу парсер с запросом по «Языку поиска», страницы фильма нет', function () {
        resetTor(); store.parser_use = true; store.tapokhub_open_direct = true;
        TH.card(movieA, 'movie').params.emit.onlyEnter();
        assert.strictEqual(calls.routed, null, 'страница фильма не открывалась');
        assert.strictEqual(calls.activity.length, 1);
        var a = calls.activity[0];
        assert.strictEqual(a.component, 'torrents'); assert.strictEqual(a.movie.id, 550); assert.strictEqual(a.page, 1);
        assert.strictEqual(a.search, 'Fight Club', 'по умолчанию — оригинальное название'); assert.strictEqual(a.search_one, 'Бойцовский клуб'); assert.strictEqual(a.search_two, 'Fight Club');
        assert.strictEqual(tor.loading.length, 0, 'запускать нечего: обычный список парсера');
        store.parse_lang = 'lg_df_year'; calls.activity.length = 0;
        TH.card(movieA, 'movie').params.emit.onlyEnter();
        assert.strictEqual(calls.activity[0].search, 'Бойцовский клуб Fight Club 0000', 'комбинации те же, что у кнопки «Торренты» (год неизвестен — 0000, как в Lampa)');
    });

    await test('«Открывать фильм сразу через торрент»: сериал ищется по name/original_name', function () {
        resetTor(); store.parser_use = true; store.tapokhub_open_direct = true;
        TH.card(seriesA, 'tv').params.emit.onlyEnter();
        var a = calls.activity[0];
        assert.strictEqual(a.search, 'Breaking Bad'); assert.strictEqual(a.search_one, 'Во все тяжкие'); assert.strictEqual(a.movie.title, 'Во все тяжкие');
        store.parse_lang = 'lg_year'; calls.activity.length = 0;
        TH.card(seriesA, 'tv').params.emit.onlyEnter();
        assert.strictEqual(calls.activity[0].search, 'Во все тяжкие 2008');
    });

    await test('«Открывать фильм сразу через торрент»: торрент выбран — запускается без страницы фильма и без списка парсера (даже при выключенном автозапуске кнопки)', async function () {
        resetTor(); store.parser_use = true; store.tapokhub_open_direct = true;
        Lampa.Torrent.start(torrA, movieA); calls.activity.length = 0; calls.noty = [];
        store.tapokhub_play_auto = false;
        TH.card(movieA, 'movie').params.emit.onlyEnter();
        await wait(80);
        assert.strictEqual(calls.routed, null); assert.strictEqual(calls.activity.length, 0, 'ни страницы фильма, ни парсера');
        assert.strictEqual(tor.hashCalls[0].link, 'magnet:?xt=urn:btih:AAA', 'выбранный торрент добавлен в TorrServer');
        assert.strictEqual(tor.opens[0][0], 'HASH1', 'дальше Lampa показывает файлы и запускает');
        // без настройки «Запускать выбранный» кнопка «Торренты» на странице фильма по-прежнему открывает парсер
        resetTor(); Lampa.Torrent.start(torrA, movieA); calls.activity.length = 0; store.tapokhub_play_auto = false;
        Lampa.Activity.push(torrentsScreen(movieA));
        assert.strictEqual(calls.activity.length, 1);
    });

    await test('«Открывать фильм сразу через торрент»: парсер или торренты отключены в Lampa — обычная страница фильма', function () {
        resetTor(); store.tapokhub_open_direct = true; store.parser_use = false;
        var card = TH.card(movieA, 'movie');
        card.params.emit.onlyEnter();
        assert.strictEqual(calls.routed[0], 'full'); assert.strictEqual(calls.activity.length, 0);
        store.parser_use = true; window.lampa_settings = { torrents_use: false }; calls.routed = null;
        card.params.emit.onlyEnter();
        assert.strictEqual(calls.routed[0], 'full', 'торренты отключены сборкой Lampa');
        delete window.lampa_settings;
    });

    await test('автозапуск: настройки — три переключателя (включены по умолчанию) и «забыть выбранные»', async function () {
        var byName = {}; (calls.settingsParams || []).forEach(function (p) { if (p.component === 'tapokhub_play') byName[p.param.name || p.param.type] = p; });
        ['tapokhub_play_auto', 'tapokhub_play_fallback', 'tapokhub_play_press'].forEach(function (n) {
            assert.strictEqual(byName[n].param.type, 'trigger'); assert.strictEqual(byName[n].param.default, true, n);
        });
        resetTor(); Lampa.Torrent.start(torrA, movieA); Lampa.Torrent.start({ MagnetUri: 'x', Title: 't' }, seriesA);
        flow({ 'POST torrents/forget': [null, { deleted: 2 }] });
        byName.tapokhub_play_forget.onChange();
        await wait(10);
        assert.deepStrictEqual(lstore[TH.play.storageKey()], {});
        assert.ok(/забыто выбранных торрентов: 2/.test(calls.noty[0]));
        Lampa.Activity.push(torrentsScreen(movieA));
        assert.strictEqual(calls.activity.length, 1, 'после «забыть» снова список парсера');
    });

    Lampa.Activity.push = nativePush; resetTor(); lstore = {};

    /* ---------- рекомендации по просмотренному ---------- */

    var ep = function (name, s, e) { return 'h:' + [s, s > 10 ? ':' : '', e, name].join(''); };
    var resetRecs = function () { favLists = {}; timeline = {}; viewedIds = []; viewedTv = []; calls.noty = []; };

    await test('рекомендации: фильм считается просмотренным с 70%, начатый и брошенный раньше нет', function () {
        resetRecs();
        var m = { id: 1, title: 'Фильм', original_title: 'Film' };
        timeline['h:Film'] = 95; assert.strictEqual(TH.recs.isWatched(m), true);
        timeline['h:Film'] = 70; assert.strictEqual(TH.recs.isWatched(m), true, 'ровно 70% уже просмотрено');
        timeline['h:Film'] = 69; assert.strictEqual(TH.recs.isWatched(m), false, 'не дошёл до 70%');
        timeline['h:Film'] = 10; assert.strictEqual(TH.recs.isWatched(m), false);
        delete timeline['h:Film']; assert.strictEqual(TH.recs.isWatched(m), false, 'не смотрел совсем');
    });

    await test('рекомендации: отметка «Просмотрено» в Lampa делает позицию просмотренной без прогресса', function () {
        resetRecs(); viewedIds = [5]; viewedTv = [];
        assert.strictEqual(TH.recs.isWatched({ id: 5, original_title: 'X' }), true);
        assert.strictEqual(TH.recs.isWatched({ id: 5, original_name: 'S', number_of_seasons: 3 }), false, 'у фильма и сериала бывает один номер: отметка фильма сериалу не принадлежит');
        viewedTv = [5];
        assert.strictEqual(TH.recs.isWatched({ id: 5, original_name: 'S', number_of_seasons: 3 }), true, 'отметка сериала — просмотренный сериал');
    });

    await test('рекомендации: сериал — не меньше трёх досмотренных серий, в любых сезонах; начатые не считаются', function () {
        resetRecs();
        var tv = { id: 2, name: 'Сериал', original_name: 'Show', number_of_seasons: 3 };
        timeline[ep('Show', 1, 1)] = 100; timeline[ep('Show', 1, 2)] = 72;
        assert.strictEqual(TH.recs.isWatched(tv), false, 'две серии — мало');
        timeline[ep('Show', 2, 5)] = 70;
        assert.strictEqual(TH.recs.isWatched(tv), true, 'третья серия из другого сезона засчитана');
        resetRecs();
        [1, 2, 3, 4, 5].forEach(function (e) { timeline[ep('Show', 1, e)] = 60; });
        assert.strictEqual(TH.recs.isWatched(tv), false, 'пять серий начаты наполовину — не просмотрено');
        resetRecs();
        [1, 2, 3].forEach(function (e) { timeline[ep('Show', 12, e)] = 100; });
        assert.strictEqual(TH.recs.isWatched({ id: 3, original_name: 'Show', number_of_seasons: 15 }), true, 'сезоны выше 10 считаются по правилу Lampa (с двоеточием)');
    });

    await test('рекомендации: collect — просмотренное от свежего к старому, в исключения всё начатое и просмотренное', function () {
        resetRecs();
        favLists.history = [
            { id: 10, title: 'Свежий', original_title: 'Fresh' },
            { id: 11, title: 'Начатый', original_title: 'Started' },
            { id: 12, name: 'Сериал', original_name: 'Show', number_of_seasons: 1 },
            { id: 13, title: 'Старый', original_title: 'Old' }
        ];
        favLists.viewed = [{ id: 14, title: 'Отмечен', original_title: 'Marked' }, { id: 10, title: 'Свежий', original_title: 'Fresh' }];
        timeline['h:Fresh'] = 100; timeline['h:Started'] = 30; timeline['h:Old'] = 99;
        [1, 2, 3].forEach(function (e) { timeline[ep('Show', 1, e)] = 100; });
        viewedIds = [14];
        var got = TH.recs.collect();
        assert.deepStrictEqual(got.seeds.map(function (s) { return s.kind + ':' + s.id + ':' + s.title; }), ['movie:10:Свежий', 'tv:12:Сериал', 'movie:13:Старый', 'movie:14:Отмечен']);
        assert.deepStrictEqual(got.exclude.map(function (s) { return s.kind + ':' + s.id; }), ['movie:10', 'movie:11', 'tv:12', 'movie:13', 'movie:14'], 'начатый фильм 11 в исключениях, но не в «просмотренном»; дублей нет');
        assert.deepStrictEqual([got.movies, got.tv], [3, 1]);
    });

    await test('рекомендации: серверу уходит не больше 40 последних просмотренных', function () {
        resetRecs();
        favLists.history = [];
        for (var i = 1; i <= 60; i++) { favLists.history.push({ id: i, title: 'Ф' + i, original_title: 'F' + i }); timeline['h:F' + i] = 100; }
        var got = TH.recs.collect();
        assert.strictEqual(got.seeds.length, 40);
        assert.strictEqual(got.seeds[0].id, 1);
        assert.strictEqual(got.exclude.length, 60, 'исключаем всё, что смотрел');
    });

    var storeBefore = lstore;
    await test('автоотметка: фильм с 70%+ получает отметку «Просмотрено», начатый меньше — нет, сериалы не трогаем', function () {
        resetRecs(); favAdded = []; lstore = {};
        favLists.history = [
            { id: 20, title: 'Досмотрен', original_title: 'Done' }, { id: 21, title: 'Начат', original_title: 'Half' },
            { id: 22, title: 'Уже с отметкой', original_title: 'Marked' }, { id: 23, name: 'Сериал', original_name: 'Ser', number_of_seasons: 1 }];
        timeline['h:Done'] = 70; timeline['h:Half'] = 69; timeline['h:Marked'] = 100; viewedIds = [22];
        [1, 2, 3, 4].forEach(function (e) { timeline[ep('Ser', 1, e)] = 100; });
        assert.strictEqual(TH.recs.autoMark(), 1);
        assert.deepStrictEqual(favAdded, [['viewed', 20]], 'только один фильм; 22 уже отмечен, 21 мало, сериал не трогаем');
        assert.strictEqual(TH.recs.autoMark(), 0, 'повторный проход ничего не добавляет');
        assert.deepStrictEqual(favAdded, [['viewed', 20]]);
    });

    await test('автоотметка: снятую человеком отметку не возвращаем', function () {
        resetRecs(); favAdded = []; lstore = {};
        favLists.history = [{ id: 30, title: 'Ф', original_title: 'F30' }];
        timeline['h:F30'] = 80;
        assert.strictEqual(TH.recs.autoMark(), 1);
        viewedIds = [];                                  // человек снял отметку в Lampa
        assert.strictEqual(TH.recs.autoMark(), 0, 'уже отмечали один раз');
        assert.strictEqual(favAdded.length, 1);
    });

    await test('автоотметка: проверка после сохранения прогресса (от 70%), не чаще раза в 3 секунды', async function () {
        resetRecs(); favAdded = []; lstore = {};
        assert.ok(tlHandlers.length >= 1, 'подписка на прогресс плеера сделана');
        favLists.history = [{ id: 40, title: 'Ф', original_title: 'F40' }];
        timeline['h:F40'] = 75;
        var h = tlHandlers[tlHandlers.length - 1];
        h({ data: { hash: 'x', road: { percent: 30 } } });      // рано: ничего не планируется
        h({ data: { hash: 'x', road: { percent: 75 } } }); h({ data: { hash: 'x', road: { percent: 76 } } });
        await wait(3100);
        assert.deepStrictEqual(favAdded, [['viewed', 40]], 'одна проверка на два события');
    });

    await test('автоотметка: сводка главного экрана считает свежие отметки', async function () {
        resetRecs(); favAdded = []; lstore = {};
        favLists.history = [{ id: 50, title: 'Ф', original_title: 'F50' }]; timeline['h:F50'] = 71;
        flow({ 'GET stats': [null, { movies: 1, tv: 0, collections: 0, ids: { movie: [50], tv: [] } }] });
        var h = newHome(), root = h.render(true);
        var statsEl = stageEl(root).children[0].children.filter(function (c) { return c.className === 'tapokhub-home__stats'; })[0];
        h.start(); await wait(15);
        assert.ok(/<b>1<\/b><span>ПРОСМОТРЕНО/.test(statsEl.innerHTML), statsEl.innerHTML);
        h.destroy();
    });
    lstore = storeBefore;

    var openRecs = async function () { var s = calls.components.tapokhub_recommend({}); s.fire('create'); await wait(25); return s; };

    await test('рекомендации: экран — запрос со списком, фильмы и сериалы отдельными группами, фон Lampa не трогаем', async function () {
        resetRecs();
        favLists.history = [{ id: 10, title: 'Свежий', original_title: 'Fresh' }, { id: 12, name: 'Сериал', original_name: 'Show', number_of_seasons: 1 }];
        timeline['h:Fresh'] = 100; [1, 2, 3].forEach(function (e) { timeline[ep('Show', 1, e)] = 100; });
        var sent = null;
        flow({ 'POST recommend': function (body) { sent = body; return [null, { items: [
            { id: 50, media_type: 'movie', title: 'Р1', poster_path: '/a.jpg', because: ['Свежий'] },
            { id: 60, media_type: 'tv', name: 'Р2', poster_path: '/b.jpg' },
            { id: 51, media_type: 'movie', title: 'Р3', poster_path: '/c.jpg' }] }]; } });
        var s = await openRecs();
        assert.deepStrictEqual(sent.seeds, [{ kind: 'movie', id: 10, title: 'Свежий' }, { kind: 'tv', id: 12, title: 'Сериал' }]);
        assert.deepStrictEqual(sent.exclude, [{ kind: 'movie', id: 10 }, { kind: 'tv', id: 12 }]);
        var g = s.sections();
        assert.deepStrictEqual(g.map(function (x) { return x.title; }), ['Фильмы по вашим просмотрам · учтено 1 фильм', 'Сериалы по вашим просмотрам · учтено 1 сериал']);
        assert.deepStrictEqual(g.map(function (x) { return x.cards.map(function (c) { return c.id; }); }), [[50, 51], [60]]);
        assert.strictEqual(g[0].cards[0].params.emit.onlyFocus, undefined, 'на экране свой фон');
        var n = calls.noty.length; s.fire('start');
        assert.ok(TH.backdrop.owner(), 'размытый фон хаба включён');
        s.fire('destroy');
        assert.strictEqual(calls.noty.length, n);
    });

    await test('рекомендации: нечего рекомендовать, сервер не ответил, нет входа — пустой экран с пояснением', async function () {
        resetRecs();
        var s = await openRecs();
        assert.ok(s.emptied && !s.built);
        assert.ok(/нужны досмотренные.*от 3 серий/.test(calls.noty[0]), calls.noty[0]);
        favLists.history = [{ id: 10, title: 'Свежий', original_title: 'Fresh' }]; timeline['h:Fresh'] = 100; calls.noty = [];
        flow({ 'POST recommend': [{ status: 0 }, null] });
        s = await openRecs();
        assert.ok(s.emptied && /Не удалось/.test(calls.noty[0]));
        flow({ 'POST recommend': [null, { items: [] }] });
        s = await openRecs();
        assert.ok(s.emptied, 'сервер ничего не нашёл — пусто, без падения');
    });

    /* ---------- вход: токен устройства, аккаунт CUB, ручной токен ---------- */

    var authCalls = [];
    var authAnswer = function () { return [null, {}]; };
    var realTransport = TH.lib.transport;
    var proxyBaseBefore = TH.proxy.base();
    TH.lib.transport = function (method, url, body, done) {
        authCalls.push({ method: method, url: url, body: body });
        var r = authAnswer(method, url, body);
        setTimeout(function () { done(r[0], r[1]); }, 0);
    };
    var savedHost = TH.proxyHost;
    var resetAuth = function () { lstore = {}; permit.token = undefined; permit.profile = undefined; authCalls.length = 0; calls.noty = []; TH.proxy.configure(''); };

    await test('вход: без адреса сервера в сборке ничего не включается', function () {
        resetAuth(); TH.proxyHost = '@@PROXY_HOST@@';
        lstore.tapokhub_token = 'abc';
        TH.auth.init();
        assert.strictEqual(TH.proxy.base(), '');
        assert.strictEqual(TH.auth.base(), '');
    });

    await test('вход: сохранённый токен включает подмены и библиотеку, адрес строится из хоста и токена', function () {
        resetAuth(); TH.proxyHost = 'https://hub.test/';
        lstore.tapokhub_token = 'to/ken+1';
        TH.auth.init();
        assert.strictEqual(TH.proxy.base(), 'https://hub.test/tmdb/to%2Fken%2B1', 'токен в адресе экранируется, слэш на конце хоста не мешает');
        assert.strictEqual(TH.lib.enabled(), true);
        assert.strictEqual(authCalls.length, 0, 'с токеном на старте никуда не ходим для входа');
    });

    await test('вход: нет токена, но Lampa вошла в CUB — один тихий вход по аккаунту', async function () {
        resetAuth(); TH.proxyHost = 'https://hub.test';
        permit.token = 'cub-secret'; permit.profile = { id: 'p7' }; lstore.device_name = 'Гостиная';
        authAnswer = function () { return [null, { token: 'device-tok', user: { email: 'me@example.com' } }]; };
        TH.auth.init(); await wait(10);
        var c = authCalls.filter(function (x) { return /auth\/cub$/.test(x.url); })[0];
        assert.deepStrictEqual([c.method, c.url, c.body], ['POST', 'https://hub.test/tmdb/auth/cub', { domain: 'cub.test', token: 'cub-secret', profile: 'p7', device: 'Гостиная' }]);
        assert.strictEqual(lstore.tapokhub_token, 'device-tok', 'сохранён токен устройства');
        assert.ok(JSON.stringify(lstore).indexOf('cub-secret') === -1, 'токен аккаунта нигде не сохраняется');
        assert.strictEqual(TH.proxy.base(), 'https://hub.test/tmdb/device-tok');
        assert.ok(/вход выполнен \(me@example.com\)/.test(calls.noty[0]));
    });

    await test('вход: не пустили — понятное сообщение один раз в полдня, токен не сохраняется', async function () {
        resetAuth(); TH.proxyHost = 'https://hub.test';
        permit.token = 'cub-secret';
        authAnswer = function () { return [{ status: 403, message: 'CUB не признал токен аккаунта' }, null]; };
        TH.auth.init(); await wait(10);
        assert.ok(/TapokHub: .*(закрыт|CUB)/.test(calls.noty[0]), calls.noty[0]);
        assert.strictEqual(lstore.tapokhub_token, undefined);
        assert.strictEqual(TH.proxy.base(), '');
        var n = authCalls.length; calls.noty = [];
        TH.auth.init(); await wait(10);
        assert.strictEqual(authCalls.length, n, 'повторно сразу не спрашиваем и не беспокоим');
        assert.deepStrictEqual(calls.noty, []);
    });

    await test('вход: сервер недоступен при тихом входе — без сообщений (интернета может не быть)', async function () {
        resetAuth(); TH.proxyHost = 'https://hub.test'; permit.token = 'cub-secret';
        authAnswer = function () { return [{ status: 0 }, null]; };
        TH.auth.init(); await wait(10);
        assert.deepStrictEqual(calls.noty, []);
        assert.strictEqual(lstore.tapokhub_login_denied_at, undefined, 'и отказом это не считается');
    });

    await test('вход: не вошла в CUB — тихо ничего не делаем', async function () {
        resetAuth(); TH.proxyHost = 'https://hub.test';
        TH.auth.init(); await wait(5);
        assert.strictEqual(authCalls.length, 0);
    });

    await test('вход: ручной токен проверяется на сервере; неверный не сохраняется и прежний остаётся', async function () {
        resetAuth(); TH.proxyHost = 'https://hub.test'; lstore.tapokhub_token = 'old'; TH.auth.apply();
        authAnswer = function () { return [null, { id: 2, email: 'x@example.com' }]; };
        var res; TH.auth.setToken('  new-token  ', function (e, u) { res = [e, u]; }); await wait(5);
        assert.strictEqual(lstore.tapokhub_token, 'new-token', 'пробелы обрезаны');
        assert.ok(authCalls.some(function (c) { return c.url === 'https://hub.test/tmdb/new-token/whoami'; }), 'токен проверен на сервере');
        assert.ok(authCalls.some(function (c) { return c.url === 'https://hub.test/tmdb/new-token/lib/torrents' && c.method === 'GET'; }), 'после успешного входа подтянуты выбранные торренты');
        assert.strictEqual(res[1].email, 'x@example.com');
        authAnswer = function () { return [{ status: 404 }, null]; };
        TH.auth.setToken('wrong', function (e) { res = [e]; }); await wait(5);
        assert.strictEqual(lstore.tapokhub_token, 'new-token', 'неверный токен откатился к прежнему');
        assert.strictEqual(TH.proxy.base(), 'https://hub.test/tmdb/new-token');
        assert.strictEqual(res[0].status, 404);
    });

    await test('вход: выход стирает токен и выключает подмены', function () {
        resetAuth(); TH.proxyHost = 'https://hub.test'; lstore.tapokhub_token = 'abc'; TH.auth.apply();
        assert.ok(TH.lib.enabled());
        TH.auth.logout();
        assert.strictEqual(lstore.tapokhub_token, '');
        assert.strictEqual(TH.proxy.base(), '');
        assert.strictEqual(TH.lib.enabled(), false);
    });

    await test('вход: причины отказа объяснены по-русски', function () {
        assert.strictEqual(TH.auth.explain({ status: 403, message: 'регистрация на сервере закрыта' }), 'регистрация на сервере закрыта');
        assert.ok(/доступ закрыт/.test(TH.auth.explain({ status: 403 })));
        assert.ok(/аккаунт CUB/.test(TH.auth.explain({ status: 401 })));
        assert.ok(/не узнал токен/.test(TH.auth.explain({ status: 404 })));
        assert.ok(/подождите/.test(TH.auth.explain({ status: 429 })));
        assert.ok(/недоступен/.test(TH.auth.explain({ status: 0 })));
        assert.ok(/нет связи с сервером/.test(TH.auth.explain({ status: 0, message: 'network' })));
        assert.ok(/от CUB \(ответ 500\)/.test(TH.auth.explain({ status: 424, message: 'ответ 500' })));
        assert.strictEqual(TH.auth.explain({ status: 400, message: 'неизвестный домен CUB' }), 'сервер не принял запрос (неизвестный домен CUB)', 'причину от сервера показываем');
    });

    await test('настройки: строка «Сервер» показывает версию сервера', function () {
        var row = (calls.settingsParams || []).filter(function (p) { return p.param.name === 'tapokhub_server'; })[0];
        var realTransport = TH.lib.transport, prevDollar = global.$, asked = [];
        global.$ = function () { var el = { t: '', append: function () {}, text: function (v) { el.t = v; } }; return el; };
        function render(reply) {
            var out; TH.lib.transport = function (m, url, body, cb) { asked.push(url); cb(reply[0], reply[1]); };
            global.$ = function () { var el = { text: function (v) { el.t = v; return el; }, append: function () {} }; out = el; return el; };
            row.onRender({ append: function () {} });
            return out.t;
        }
        try {
            resetAuth(); TH.proxyHost = 'https://hub.test'; lstore.tapokhub_token = 'tok';
            assert.strictEqual(render([null, { ok: true, version: '0.9.0-pre.2' }]), 'Версия 0.9.0-pre.2');
            assert.strictEqual(render([{ status: 0 }, null]), 'Не отвечает или не принимает токен');
            assert.ok(/\/tmdb\/tok\/health$/.test(asked[0]), 'спрашиваем /health: ' + asked[0]);
            delete lstore.tapokhub_token;
            assert.strictEqual(render([null, { ok: true }]), 'Вход не выполнен');
        } finally { TH.lib.transport = realTransport; global.$ = prevDollar; }
    });

    await test('Telegram: строка состояния и понятные ошибки', function () {
        var t = TH.telegram;
        assert.ok(/не подключён/.test(t.describe({ token: false })));
        assert.ok(/@tapok_bot.*чат не привязан/.test(t.describe({ token: true, username: 'tapok_bot', chat: null })));
        assert.strictEqual(t.describe({ token: true, username: 'tapok_bot', chat: '555', running: true }), '@tapok_bot · чат 555 · работает');
        assert.ok(/остановлен \(нет связи с Telegram\)/.test(t.describe({ token: true, username: 'b', chat: '5', running: false, error: 'нет связи с Telegram' })));
        assert.strictEqual(t.explain({ status: 0 }), 'нет связи с сервером');
        assert.ok(/войдите заново/.test(t.explain({ status: 404 })));
        assert.strictEqual(t.explain({ status: 400, message: 'неверный токен' }), 'неверный токен');
    });

    await test('Telegram: страница настроек, ввод токена и чата уходит на сервер, отключение', async function () {
        var byPage = {};
        (calls.settingsParams || []).forEach(function (p) { (byPage[p.component] = byPage[p.component] || []).push(p); });
        assert.deepStrictEqual((byPage.tapokhub_tg || []).map(function (p) { return p.param.name || p.param.type; }),
            ['title', 'tapokhub_tg_status', 'tapokhub_tg_account', 'title', 'tapokhub_tg_token_paste', 'tapokhub_tg_token', 'title', 'tapokhub_tg_pair', 'tapokhub_tg_chat_paste', 'tapokhub_tg_chat', 'title', 'tapokhub_tg_off']);
        var by = {}; byPage.tapokhub_tg.forEach(function (p) { by[p.param.name] = p; });

        var realTransport = TH.lib.transport, prevBase = TH.proxy.base(), sent = [], answer;
        TH.lib.transport = function (method, url, body, cb) { sent.push({ method: method, url: url, body: body }); cb(answer[0], answer[1]); };
        try {
            TH.proxy.configure(LB);

            // токен: окно ввода без сохранения в истории, значение уходит только на сервер
            answer = [null, { token: true, username: 'tapok_bot', chat: null, running: true, pairing: true }];
            calls.noty = []; calls.input = null; by.tapokhub_tg_token.onChange();
            assert.ok(calls.input.params.nosave && calls.input.params.free, 'токен не запоминается в истории ввода Lampa');
            calls.input.cb('  123456789:AAAA  ');
            assert.strictEqual(sent[0].method, 'POST'); assert.ok(/\/lib\/telegram$/.test(sent[0].url));
            assert.deepStrictEqual(sent[0].body, { token: '123456789:AAAA' });
            assert.ok(/отправьте ему \/start, чат привяжется сам/.test(calls.noty[calls.noty.length - 1]), 'после токена подсказка про /start');
            assert.strictEqual(lstore.tapokhub_tg_token, undefined, 'на устройстве токен не остаётся');

            // чат: в окне подставлен прежний номер; ответ с проверочным сообщением
            answer = [null, { token: true, username: 'tapok_bot', chat: '555', running: true, test: 'ok' }];
            calls.input = null; by.tapokhub_tg_chat.onChange();
            calls.input.cb('555');
            assert.deepStrictEqual(sent[sent.length - 1].body, { chat: '555' });
            assert.ok(/бот подключён, в Telegram пришло сообщение/.test(calls.noty[calls.noty.length - 1]));
            calls.input = null; by.tapokhub_tg_chat.onChange();
            assert.strictEqual(calls.input.params.value, '555', 'в окне текущий номер чата');

            // бот не смог написать в чат
            answer = [null, { token: true, username: 'tapok_bot', chat: '555', running: true, test: 'Forbidden: bot can\'t initiate conversation' }];
            calls.input.cb('555');
            assert.ok(/написать в чат не удалось.*Start/.test(calls.noty[calls.noty.length - 1]));

            // сервер отказал: причина показана человеку
            answer = [{ status: 400, message: 'это не похоже на токен бота' }, null];
            calls.input = null; by.tapokhub_tg_token.onChange(); calls.input.cb('плохой');
            assert.strictEqual(calls.noty[calls.noty.length - 1], 'TapokHub: это не похоже на токен бота');

            // пустой ввод ничего не отправляет
            var n = sent.length; calls.input = null; by.tapokhub_tg_token.onChange(); calls.input.cb('   ');
            assert.strictEqual(sent.length, n);

            // отключение
            answer = [null, { token: false, chat: null, running: false }];
            by.tapokhub_tg_off.onChange();
            assert.deepStrictEqual(sent[sent.length - 1].body, { clear: true });
            assert.strictEqual(calls.noty[calls.noty.length - 1], 'TapokHub: Telegram-бот отключён');

            // без входа на сервер не ходим
            TH.proxy.configure('');
            n = sent.length; by.tapokhub_tg_off.onChange();
            assert.strictEqual(sent.length, n);
            assert.ok(/сначала войдите/.test(calls.noty[calls.noty.length - 1]));
        } finally { TH.lib.transport = realTransport; TH.proxy.configure(prevBase); }
    });

    await test('Регистрация: пункт на главной странице, владелец выбирает открытую или закрытую, остальные нет', async function () {
        var reg = (calls.settingsParams || []).filter(function (p) { return p.component === 'tapokhub' && p.param.name === 'tapokhub_registration'; })[0];
        assert.ok(reg, 'пункт «Регистрация на сервере» есть на главной странице настроек');
        var r = TH.registration;
        assert.strictEqual(r.describe({ admin: false }), 'Настраивает владелец сервера');
        assert.ok(/^Открытая/.test(r.describe({ admin: true, open: true })));
        assert.ok(/^Закрытая/.test(r.describe({ admin: true, open: false })));
        assert.ok(/только владелец/.test(r.explain({ status: 403 })));

        var realTransport = TH.lib.transport, prevBase = TH.proxy.base(), sent = [], answer, prevDollar = global.$;
        var text = '';
        global.$ = function () { return { text: function (t) { text = t; return this; }, append: function () {} }; };
        TH.lib.transport = function (method, url, body, cb) { sent.push({ method: method, url: url, body: body }); cb(answer[0], answer[1]); };
        try {
            TH.proxy.configure(LB);

            // владелец: строка показывает значение, выбор открывает список, «Открытая» уходит на сервер
            answer = [null, { admin: true, open: false }];
            reg.onRender({ append: function () {} });
            assert.ok(/\/lib\/registration$/.test(sent[0].url) && sent[0].method === 'GET');
            assert.ok(/^Закрытая/.test(text));
            calls.select = null; calls.noty = [];
            reg.onChange();
            assert.deepStrictEqual(calls.select.items.map(function (i) { return [i.open, !!i.selected]; }), [[false, true], [true, false]], 'текущее значение отмечено');
            answer = [null, { admin: true, open: true }];
            calls.select.onSelect(calls.select.items[1]);
            assert.strictEqual(sent[sent.length - 2].method, 'POST');
            assert.deepStrictEqual(sent[sent.length - 2].body, { open: true });
            assert.strictEqual(calls.noty[calls.noty.length - 1], 'TapokHub: регистрация открыта');
            assert.ok(/^Открытая/.test(text), 'строка обновилась');

            // выбрали то, что уже стоит: на сервер ничего не уходит
            var n = sent.length; calls.select = null; reg.onChange();
            calls.select.onSelect(calls.select.items[1]);
            assert.strictEqual(sent.length, n);

            // не владелец: строка объясняет, выбор не открывается
            answer = [null, { admin: false }];
            reg.onRender({ append: function () {} });
            assert.strictEqual(text, 'Настраивает владелец сервера');
            calls.select = null; calls.noty = []; reg.onChange();
            assert.strictEqual(calls.select, null);
            assert.ok(/только владелец/.test(calls.noty[0]));

            // сервер отказал: причина показана человеку
            answer = [{ status: 403, message: 'x' }, null];
            r.save(false);
            assert.ok(/только владелец/.test(calls.noty[calls.noty.length - 1]));

            // без входа на сервер не ходим
            TH.proxy.configure('');
            n = sent.length; reg.onRender({ append: function () {} });
            assert.strictEqual(sent.length, n);
            assert.ok(/войдите/.test(text));
        } finally { TH.lib.transport = realTransport; TH.proxy.configure(prevBase); global.$ = prevDollar; }
    });

    await test('Telegram: привязка чата по /start: кнопка, подсказка, слежение до привязки', async function () {
        var t = TH.telegram, cfg = t.config, old = JSON.stringify(cfg);
        var pair = (calls.settingsParams || []).filter(function (p) { return p.param.name === 'tapokhub_tg_pair'; })[0];
        assert.ok(/\/start/.test(pair.field.description) && /5 минут/.test(pair.field.description));
        assert.ok(/ждёт.*\/start/.test(t.describe({ token: true, username: 'b', chat: null, pairing: true })));
        assert.ok(/нажмите «Привязать чат»/.test(t.describe({ token: true, username: 'b', chat: null, pairing: false })));

        var realTransport = TH.lib.transport, prevBase = TH.proxy.base(), calls2 = [], phase = 0, row = null;
        cfg.watchEvery = 15;
        var prevDollar = global.$, shown = { t: '' };
        global.$ = function () { return { text: function (v) { shown.t = v; return this; }, append: function () {} }; };
        (calls.settingsParams || []).filter(function (p) { return p.param.name === 'tapokhub_tg_status'; })[0]
            .onRender({ append: function () {} });
        global.$ = prevDollar;
        TH.lib.transport = function (method, url, body, cb) {
            calls2.push(method + ' ' + JSON.stringify(body));
            if (method === 'POST') return cb(null, { token: true, username: 'b', chat: null, running: true, pairing: true });
            phase++;
            cb(null, phase < 3 ? { token: true, username: 'b', chat: null, running: true, pairing: true } : { token: true, username: 'b', chat: '777', running: true, pairing: false });
        };
        try {
            TH.proxy.configure(LB); calls.noty = [];
            pair.onChange(); await wait(20);
            assert.strictEqual(calls2[0], 'POST {"pair":true}');
            assert.ok(/откройте бота в Telegram и отправьте ему \/start/.test(calls.noty[0]));
            await wait(200);                       // сервер привязал чат: слежение заметило и остановилось
            assert.ok(calls.noty.some(function (m) { return /чат привязан, бот готов/.test(m); }), 'сообщение о привязке: ' + JSON.stringify(calls.noty));
            assert.ok(/чат 777 · работает/.test(shown.t), 'строка состояния обновилась: ' + shown.t);
            var n = calls2.length; await wait(80); assert.strictEqual(calls2.length, n, 'после привязки опрос прекращается');
        } finally { TH.lib.transport = realTransport; TH.proxy.configure(prevBase); Object.assign(cfg, JSON.parse(old)); }
    });

    await test('вставка из буфера обмена: токен бота ищется в тексте, номер чата в ответе бота, без буфера открывается ручной ввод', async function () {
        var byPage = {}; (calls.settingsParams || []).forEach(function (p) { byPage[p.param.name] = p; });
        var t = TH.telegram;
        assert.strictEqual(t.tokenFrom('Use this token to access the HTTP API:\n123456789:AAEhBOweik6ad9r_QXMENQjcrTu-uQgG8aM\nKeep your token secure'), '123456789:AAEhBOweik6ad9r_QXMENQjcrTu-uQgG8aM');
        assert.strictEqual(t.tokenFrom('просто текст'), ''); assert.strictEqual(t.tokenFrom('12:short'), '');
        assert.strictEqual(t.chatFrom(' -1001234 '), '-1001234'); assert.strictEqual(t.chatFrom('12ab'), ''); assert.strictEqual(t.chatFrom(''), '');

        var realTransport = TH.lib.transport, prevBase = TH.proxy.base(), sent = [], clip = null, hadNav = Object.getOwnPropertyDescriptor(global, 'navigator');
        function setClip(v) {
            Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: v === 'none' ? {} : { clipboard: { readText: function () { return v instanceof Error ? Promise.reject(v) : Promise.resolve(v); } } } });
        }
        TH.lib.transport = function (method, url, body, cb) { if (method === 'POST') sent.push(body); cb(null, { token: true, username: 'b', chat: '555', running: true, test: 'ok' }); };
        try {
            TH.proxy.configure(LB);
            // токен из сообщения BotFather уходит на сервер одним запросом, без лишнего текста
            setClip('Use this token:\n123456789:AAEhBOweik6ad9r_QXMENQjcrTu-uQgG8aM\nKeep it secret'); calls.noty = [];
            byPage.tapokhub_tg_token_paste.onChange(); await wait(10);
            assert.deepStrictEqual(sent, [{ token: '123456789:AAEhBOweik6ad9r_QXMENQjcrTu-uQgG8aM' }]);
            // номер чата из ответа бота
            setClip('Номер этого чата: -1001234'); byPage.tapokhub_tg_chat_paste.onChange(); await wait(10);
            assert.deepStrictEqual(sent[1], { chat: '-1001234' });
            // в буфере не то: ничего не отправляем, говорим что нашли
            sent.length = 0; setClip('привет'); byPage.tapokhub_tg_token_paste.onChange(); await wait(10);
            assert.strictEqual(sent.length, 0); assert.ok(/в буфере обмена нет токена бота/.test(calls.noty[calls.noty.length - 1]));
            setClip('без цифр'); byPage.tapokhub_tg_chat_paste.onChange(); await wait(10);
            assert.strictEqual(sent.length, 0); assert.ok(/нет номера чата/.test(calls.noty[calls.noty.length - 1]));
            // буфера нет (телевизор, http) или доступ запрещён: подсказка и сразу окно ручного ввода
            for (var v of ['none', new Error('denied')]) {
                setClip(v); calls.input = null; byPage.tapokhub_tg_token_paste.onChange(); await wait(10);
                assert.ok(/буфер обмена недоступен/.test(calls.noty[calls.noty.length - 1])); assert.ok(calls.input && /Токен Telegram-бота/.test(calls.input.params.title), 'ручной ввод');
            }
            // токен доступа TapokHub тоже вставляется: обычный текст не принимается
            setClip('два слова'); calls.noty = []; byPage.tapokhub_token_paste.onChange(); await wait(10);
            assert.ok(/обычный текст/.test(calls.noty[0]));
            setClip('none'); calls.noty = []; byPage.tapokhub_token_paste.onChange(); await wait(10);
            assert.ok(/не удалось прочитать буфер обмена/.test(calls.noty[0]));
        } finally {
            TH.lib.transport = realTransport; TH.proxy.configure(prevBase);
            if (hadNav) Object.defineProperty(global, 'navigator', hadNav); else delete global.navigator;
        }
    });

    await test('автозапуск хаба: отсчёт, открытие; любая кнопка, касание, клик и колесо отменяют, «Назад» гасится, свой переход и ссылка не перебиваются', async function () {
        var A = TH.autostart, cfg = A.config, old = JSON.stringify(cfg), pressed;
        var listeners = {};
        window.addEventListener = function (name, fn, capture) { assert.ok(capture, 'слушаем в фазе перехвата, раньше Lampa'); (listeners[name] = listeners[name] || []).push(fn); };
        function fire(type, extra) { var e = Object.assign({ type: type, preventDefault: function () { pressed = (pressed || '') + 'P'; } }, extra); (listeners[type] || []).forEach(function (h) { h(e); }); }
        cfg.seconds = 3; cfg.tick = 25; cfg.poll = 5; cfg.wait = 60;
        function fresh(active) { calls.activity = []; calls.noty = []; calls.activeActivity = active; }
        var main = { component: 'main', url: '' };
        try {
            // включён: по истечении отсчёта открывается хаб поверх стартового экрана
            store.tapokhub_autostart = true; delete window.start_deep_link;
            fresh(main); A.install();
            await wait(20); assert.ok(A.running(), 'отсчёт идёт');
            assert.ok(/откроется через 3.*любая кнопка отменяет/.test(calls.noty[0]), 'подсказка про любую кнопку: ' + calls.noty[0]);
            await wait(140);
            assert.strictEqual(calls.activity.length, 1); assert.strictEqual(calls.activity[0].component, TH.components.home);
            assert.ok(!A.running());

            // «Назад» в отсчёте: хаб не открывается, кнопка гасится (preventDefault: Lampa не выйдет из приложения), сообщение об отмене
            fresh(main); A.install(); await wait(20);
            pressed = ''; fire('keydown', { keyCode: 27 });
            assert.strictEqual(pressed, 'P', '«Назад» гасится'); assert.ok(!A.running());
            assert.ok(/Автозапуск TapokHub отменён/.test(calls.noty[calls.noty.length - 1]));
            await wait(140); assert.strictEqual(calls.activity.length, 0, 'после отмены хаб не открывается');
            for (var codes = [8, 461, 10009, 88], i = 0; i < codes.length; i++) {      // кнопки «Назад» разных устройств
                fresh(main); A.install(); await wait(20);
                A.install();                                                            // повторный запуск не плодит второй отсчёт
                pressed = ''; fire('keydown', { keyCode: codes[i] }); assert.ok(!A.running() && pressed === 'P', 'код ' + codes[i]);
            }
            // любое другое действие тоже отменяет, но обычные кнопки не гасятся: фокус в Lampa сдвинется как всегда
            for (var acts of [['keydown', { keyCode: 13 }], ['keydown', { keyCode: 40 }], ['keydown', { keyCode: 39 }], ['mousedown', {}], ['touchstart', {}], ['wheel', {}]]) {
                fresh(main); A.install(); await wait(20); assert.ok(A.running());
                pressed = ''; fire(acts[0], acts[1]);
                assert.ok(!A.running(), 'отмена по ' + acts[0] + ' ' + JSON.stringify(acts[1])); assert.strictEqual(pressed, '', 'не «Назад»: событие не гасится');
            }
            fire('keydown', { keyCode: 13 });                                           // без отсчёта нажатия ничего не значат
            assert.ok(!A.running());
            await wait(120); assert.strictEqual(calls.activity.length, 0, 'ни один отменённый отсчёт не открыл хаб');

            // человек сам открыл другой раздел: не перебиваем
            fresh(main); A.install(); await wait(20);
            calls.activeActivity = { component: 'category', url: 'movie' };
            await wait(140); assert.strictEqual(calls.activity.length, 0); assert.ok(!A.running());

            // хаб уже открыт, запуск по ссылке, настройка выключена
            fresh({ component: TH.components.home, url: '' }); A.install(); await wait(60); assert.ok(!A.running() && !calls.activity.length, 'хаб уже открыт');
            window.start_deep_link = { card: 1 }; fresh(main); A.install(); await wait(60); assert.ok(!A.running(), 'запуск по ссылке на фильм');
            delete window.start_deep_link; store.tapokhub_autostart = false; fresh(main); A.install(); await wait(60);
            assert.ok(!A.running() && !calls.activity.length, 'выключено');

            // стартовый экран не появился за отведённое время: ничего не открываем
            store.tapokhub_autostart = true; fresh(undefined); A.install(); await wait(120);
            assert.ok(!A.running() && !calls.activity.length);
        } finally { Object.assign(cfg, JSON.parse(old)); store.tapokhub_autostart = false; delete window.start_deep_link; calls.activity = []; }
    });

    await test('настройки: раздел «TapokHub» с входом через CUB, вводом токена и выходом', async function () {
        var byName = {};
        (calls.settingsParams || []).forEach(function (p) { byName[p.param.name] = p; });
        assert.strictEqual(calls.settingsComponent.component, 'tapokhub');
        assert.deepStrictEqual(['tapokhub_status', 'tapokhub_login_cub', 'tapokhub_token_input', 'tapokhub_logout'].filter(function (n) { return byName[n]; }).length, 4);
        assert.strictEqual(byName.tapokhub_login_cub.param.type, 'button');
        // ручной ввод: клавиатура Lampa, результат уходит в setToken
        resetAuth(); TH.proxyHost = 'https://hub.test';
        authAnswer = function () { return [null, { id: 3, email: 'k@example.com' }]; };
        calls.input = null; byName.tapokhub_token_input.onChange();
        assert.ok(calls.input.params.free && calls.input.params.nosave);
        calls.input.cb('typed-token');
        assert.strictEqual(lstore.tapokhub_token, undefined, 'до подтверждения аккаунт не переключается');
        await wait(10);
        assert.strictEqual(lstore.tapokhub_token, 'typed-token');
    });

    await test('настройки: раздел TapokHub поделён на пункты (Авторизация, Анимация, Воспроизведение), каждый открывает свою страницу, значок с белой обводкой', function () {
        var byComp = {};
        (calls.settingsParams || []).forEach(function (p) { (byComp[p.component] = byComp[p.component] || []).push(p); });
        var names = function (c) { return (byComp[c] || []).map(function (p) { return p.param.name || p.param.type; }); };
        assert.deepStrictEqual(names('tapokhub'), ['title', 'tapokhub_server', 'tapokhub_open_auth', 'title', 'tapokhub_open_anim', 'tapokhub_autostart', 'title', 'tapokhub_open_play', 'tapokhub_delete_collection', 'title', 'tapokhub_open_tg', 'title', 'tapokhub_registration', 'title', 'tapokhub_version']);
        var heads = byComp.tapokhub.filter(function (p) { return p.param.type === 'title'; }).map(function (p) { return p.field.name; });
        assert.deepStrictEqual(heads, ['Подключение', 'Главный экран', 'Просмотр и библиотека', 'Уведомления', 'Сервер: для владельца', 'О плагине'], 'главная страница поделена на группы');
        var ver = byComp.tapokhub[byComp.tapokhub.length - 1];
        assert.ok(ver.param.type === 'static' && ver.field.name === 'Версия', 'последней строкой версия сборки, в группе «О плагине»');
        assert.ok(ver.field.description === TH.versionLabel && /^\d+\.\d+(\.\d+)? ?\S*/.test(ver.field.description) && ver.field.description.indexOf('@@') < 0, 'подпись версии подставлена сборкой: ' + ver.field.description);
        assert.ok(TH.version.indexOf('@@') < 0 && TH.version === fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim(), 'версия в плагине равна файлу VERSION');
        var ver = require('fs').readFileSync(require('path').join(__dirname, '../../VERSION'), 'utf8').trim();
        var label = ver.indexOf('-') < 0 ? ver : ver.split('.').slice(0, 2).join('.') + ' pre-release';   // как plugin/build.py: version_label
        assert.strictEqual(TH.versionLabel, label, 'подпись версии в настройках следует файлу VERSION');
        assert.deepStrictEqual(names('tapokhub_auth'), ['title', 'tapokhub_status', 'title', 'tapokhub_login_cub', 'tapokhub_token_paste', 'tapokhub_token_input', 'title', 'tapokhub_logout']);
        assert.deepStrictEqual(names('tapokhub_anim'), ['title', 'title', 'tapokhub_anim_counters', 'tapokhub_anim_vcr', 'title', 'tapokhub_anim_crt', 'tapokhub_open_fx']);
        assert.deepStrictEqual(names('tapokhub_fx'), ['title', 'title', 'tapokhub_fx_edit', 'title', 'tapokhub_open_fx_pos', 'tapokhub_open_fx_corners', 'tapokhub_open_fx_trap', 'tapokhub_open_fx_bulge', 'title', 'tapokhub_fx_show', 'tapokhub_fx_reset']);
        assert.deepStrictEqual(names('tapokhub_fx_pos'), ['title', 'tapokhub_fx_left', 'tapokhub_fx_right', 'tapokhub_fx_top', 'tapokhub_fx_bottom']);
        assert.strictEqual(names('tapokhub_fx_corners').length, 10, 'заголовок, скругление и 8 полей: X и Y четырёх углов'); assert.strictEqual(names('tapokhub_fx_corners')[1], 'tapokhub_fx_radius');
        assert.deepStrictEqual(names('tapokhub_fx_trap'), ['title', 'tapokhub_fx_nTop', 'tapokhub_fx_nBottom', 'tapokhub_fx_nLeft', 'tapokhub_fx_nRight']);
        assert.deepStrictEqual(names('tapokhub_fx_bulge'), ['title', 'tapokhub_fx_bTop', 'tapokhub_fx_bBottom', 'tapokhub_fx_bLeft', 'tapokhub_fx_bRight']);
        assert.ok(/stroke="white"/.test(calls.settingsComponent.icon) && /viewBox="0 0 39 39"/.test(calls.settingsComponent.icon), 'значок как у остальных разделов настроек: без обводки был чёрный квадрат');
        assert.ok(calls.templates.settings_tapokhub_auth && calls.templates.settings_tapokhub_anim, 'страницы зарегистрированы как шаблоны, но не добавлены в общий список настроек');
        var opened = [];
        var saved = Lampa.Settings; Lampa.Settings = { create: function (n, p) { opened.push([n, p && typeof p.onBack]); if (p && p.onBack) opened.push(['back', n]); } };
        byComp.tapokhub.filter(function (p) { return p.param.name === 'tapokhub_open_auth'; })[0].onChange();
        assert.deepStrictEqual(opened[0], ['tapokhub_auth', 'function']);
        var back = []; Lampa.Settings = { create: function (n, p) { back.push(n); } };
        Lampa.Settings.create('tapokhub_auth', { onBack: function () { Lampa.Settings.create('tapokhub'); } });
        Lampa.Settings = saved;
    });

    await test('экраны без входа: пустой экран и подсказка, куда идти', async function () {
        resetAuth();
        var s = calls.components.tapokhub_library({}); s.fire('create'); await wait(10);
        assert.ok(s.emptied && !s.built);
        assert.ok(/выполните вход/.test(calls.noty[0]) && /Настройки/.test(calls.noty[0]));
        calls.noty = [];
    });

    await test('экраны без входа: библиотека молчит и не ходит на сервер', function () {
        resetAuth();
        var n = authCalls.length; var got = null;
        TH.lib.loadCollections(function (l) { got = l; });
        assert.deepStrictEqual(got, []);
        assert.strictEqual(authCalls.length, n);
    });

    TH.lib.transport = realTransport; TH.proxyHost = savedHost; lstore = {};
    TH.proxy.configure(proxyBaseBefore);

    TH.proxy.configure('');

    console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
    process.exit(failed ? 1 : 0);
})();
