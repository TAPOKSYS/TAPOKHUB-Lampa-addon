/* ---------- плитки коллекций и экран «Библиотека» ---------- */

function openFranchise(f) {
    Lampa.Activity.push({ url: '', title: f.title, component: TH.components.franchise, franchise_id: f.id, page: 1 });
}

// Плитка коллекции: нативная карточка в стиле «collection» (как подборки CUB): кадр и название.
// Название заменяется логотипом, если он найден (f.logo). Открывает экран франшизы.
// Метка NEW, если в коллекции есть новое.
function franchiseTile(f) {
    var cover = f.cover || {};

    TH.proxy.know.image(cover.backdrop_path);
    TH.proxy.know.image(cover.poster_path);
    TH.proxy.know.image(f.logo);

    return {
        id: 900000000 + f.id,                     // чтобы не пересечься с настоящими id TMDB
        media_type: 'movie',
        title: f.title, original_title: f.title, release_date: '', vote_average: 0, overview: '',
        backdrop_path: cover.backdrop_path || cover.poster_path || null,
        poster_path: cover.poster_path || null,
        source: 'tapokhub',
        tapokhub_franchise: f.id,
        params: {
            style: { name: 'collection' },
            emit: {
                onCreate: function () {
                    if (!this.html || !this.html.addClass) return;

                    this.html.addClass('tapokhub-tile');
                    if (f.counts && f.counts.new > 0) this.html.addClass('tapokhub-tile--new');

                    TH.logos.replaceText(this.html.find ? this.html.find('.card__title') : null, f.logo, f.title);
                },
                onlyEnter: function () { openFranchise(f); }
            }
        }
    };
}

/* ---------- экраны-сетки: плитки на весь экран ----------
 *
 * Нативная Category (та же, что у «Ещё» и списков TMDB): вертикальная прокрутка, cols--N, пульт и касание.
 * Своё только одно: заголовки групп вставляются в сетку как блоки во всю ширину между карточками.
 * Фокус ходит по карточкам (навигатор собирает их из items), заголовки в нём не участвуют.
 *
 * sections: [{ title, cards, hero: {title, logo}, actions }]; hero: крупная шапка перед группой (название франшизы);
 * actions: карточки-кнопки (не фильмы): стартовый фокус ставится на первую карточку после них.
 */

function headingOf(section, big) {   // section: {title, logo}
    var el = document.createElement('div');

    el.className = 'tapokhub-head' + (big ? ' tapokhub-head--big' : '');

    var label = document.createElement('div');

    label.className = 'tapokhub-head__title';
    label.textContent = section.title;
    el.appendChild(label);

    if (section.logo) TH.logos.replaceText(label, section.logo, section.title);

    return el;
}

// Фокус по умолчанию у Category — первый элемент, то есть кнопка «Настроить». Переносим его на первую карточку
// фильма: кнопки остаются на расстоянии одного нажатия «вверх».
function focusCard(comp, skip) {
    var item = skip && comp.items && comp.items[skip];

    if (!item) return;

    comp.last = item.render(true);

    // build уже мог отдать фокус контроллеру (экран активен): переставляем его
    if (Lampa.Controller.own && Lampa.Controller.own(comp) && Lampa.Controller.collectionFocus) {
        Lampa.Controller.collectionFocus(comp.last, comp.scroll.render(true));
    }
}

function GridScreen(object, load, opts) {
    var comp = Lampa.Maker.make('Category', object);
    var destroyed = false;
    var owner = {};

    comp.use({
        onDestroy: function () { destroyed = true; TH.backdrop.hide(owner); },
        onPause: function () { TH.backdrop.hide(owner); },
        onStart: function () { if (opts && opts.backdrop) TH.backdrop.show(owner, opts.backdrop); },
        onCreate: function () {
            var self = this;

            // Без входа сервер недоступен, экран будет пустым: объясняем, что делать
            if (!TH.lib.enabled()) Lampa.Noty.show(TH.t('TapokHub: выполните вход (Настройки, раздел TapokHub)'));

            load(function (sections) {
                if (destroyed) return;

                var groups = (sections || []).filter(function (s) { return s.cards && s.cards.length; });
                var all = [];
                var buttons = 0;   // сколько кнопок стоит перед первой настоящей карточкой

                groups.forEach(function (s) {
                    if (s.actions && all.length === buttons) buttons += s.cards.length;

                    all = all.concat(s.cards);
                });

                if (!all.length) return self.empty();

                self.build({ results: all, total_pages: 1 });

                // build создаёт все карточки сразу; расставляем заголовки перед первой карточкой каждой группы
                var at = 0;

                groups.forEach(function (s) {
                    var first = self.items[at] && self.items[at].render(true);

                    if (first && first.parentNode) {
                        if (s.hero) first.parentNode.insertBefore(headingOf(s.hero, true), first);
                        if (s.title) first.parentNode.insertBefore(headingOf(s, false), first);
                    }

                    at += s.cards.length;
                });

                focusCard(self, buttons);
            });
        },
        onInstance: bindCard
    });

    return comp;
}

function cardsOf(items, plain) {
    return items.map(function (c) { return TH.card(c, c.media_type, plain ? { background: false } : null); });
}

function gridParams(object, cols) {
    object.params = object.params || {};
    object.params.items = { mapping: 'grid', cols: cols, limit_view: 6, limit_collection: 60 };

    return object;
}

// Группы библиотеки: ключ (его отдаёт сервер в поле group), заголовок в общем виде, подпись кнопки-фильтра, значок кнопки.
// Порядок групп на экране — порядок этого списка. Функция, а не константа: язык читается в момент показа.
function libraryGroupDefs() {
    return [
        { key: 'movie', title: TH.t('Мои фильмы'), label: TH.t('Фильмы'), icon: 'film' },
        { key: 'tv', title: TH.t('Мои сериалы'), label: TH.t('Сериалы'), icon: 'tv' },
        { key: 'cartoon_movie', title: TH.t('Мои мультфильмы'), label: TH.t('Мультфильмы'), icon: 'cartoon' },
        { key: 'cartoon_tv', title: TH.t('Мои мультсериалы'), label: TH.t('Мультсериалы'), icon: 'cartoon' },
        { key: 'anime', title: TH.t('Аниме и манга'), label: TH.t('Аниме и манга'), icon: 'anime' },
        { key: 'docs', title: TH.t('Документальные'), label: TH.t('Документальные'), icon: 'docs' }
    ];
}

// Группа позиции: то, что определил сервер; если его ответ без группы (старая версия), по виду фильм или сериал
function groupOf(c) {
    return c.group || (c.media_type === 'tv' ? 'tv' : 'movie');
}

// Позиции по группам: [{ def, items }] только непустые, в порядке libraryGroupDefs
function libraryGroups(items) {
    return libraryGroupDefs().map(function (def) {
        return { def: def, items: items.filter(function (c) { return groupOf(c) === def.key; }) };
    }).filter(function (g) { return g.items.length; });
}

// Группы библиотеки. Без фильтра: «Смотрю сейчас» и все группы; с фильтром (only): одна выбранная группа.
function itemSections(items, only) {
    // сериалы, которые смотрю сейчас, отдельной группой сверху (и не повторяются ниже); при фильтре не нужны
    var watching = !only && TH.recs ? TH.recs.watchingSeries(items) : [];
    var taken = {};

    watching.forEach(function (c) { taken[c.id] = true; });

    var sections = libraryGroups(items).filter(function (g) { return !only || g.def.key === only; }).map(function (g) {
        return {
            title: g.def.title,
            cards: cardsOf(g.items.filter(function (c) { return !(c.media_type === 'tv' && taken[c.id]); }), true)
        };
    });

    return only ? sections : [{ title: TH.t('Смотрю сейчас'), cards: cardsOf(watching, true) }].concat(sections);
}

// Кнопки-фильтры сверху экрана: «Все» и по кнопке на каждую непустую группу (с числом позиций). Нужны, если групп больше одной.
function libraryButtons(items, only) {
    var groups = libraryGroups(items);

    if (groups.length < 2) return null;

    function pick(key) {
        return function () { Lampa.Activity.replace({ group: key }); };
    }

    var buttons = [actionTile(900000200, 'all', TH.t('Все · ') + items.length, pick(''), !only)];

    groups.forEach(function (g, i) {
        buttons.push(actionTile(900000201 + i, g.def.icon, g.def.label + ' · ' + g.items.length, pick(g.def.key), only === g.def.key));
    });

    return { title: '', cards: buttons, actions: true };
}

// Раздел «Коллекции»: все созданные франшизы плитками на размытом фоне хаба
function CollectionsScreen(object) {
    return GridScreen(gridParams(object, 6), function (done) {
        TH.lib.loadCollections(function (list) {
            // сверху те, что смотрю сейчас (начато что-то из состава, и не всё просмотрено), от недавних к давним
            var split = TH.recs ? TH.recs.splitCollections(list) : { watching: [], rest: list };

            if (!split.watching.length) return done([{ title: '', cards: list.map(franchiseTile) }]);

            done([
                { title: TH.t('Смотрю сейчас'), cards: split.watching.map(franchiseTile) },
                { title: TH.t('Остальные коллекции'), cards: split.rest.map(franchiseTile) }
            ]);
        });
    }, { backdrop: 'blur' });
}

// Раздел «Библиотека»: только то, что добавлено по одному, по группам (фильмы, сериалы, мультфильмы, мультсериалы, аниме и манга,
// документальные) и кнопки-фильтры сверху; коллекции живут в своём разделе
function LibraryScreen(object) {
    return GridScreen(gridParams(object, 6), function (done) {
        TH.lib.loadItems(function (items) {
            var only = object.group || '';
            var known = libraryGroups(items).some(function (g) { return g.def.key === only; });

            if (!known) only = '';     // выбранная группа опустела (позиции убрали): показываем всё

            var buttons = libraryButtons(items, only);
            var sections = itemSections(items, only);

            done(buttons ? [buttons].concat(sections) : sections);
        });
    }, { backdrop: 'blur' });
}

/* ---------- экран одной франшизы и режим «Настроить» ----------
 *
 * Обычный вид: только то, что программа отобрала сама (короткие ролики, фанатские поделки и позиции с малым числом
 * голосов скрыты автоматически). Режим настройки показывает и скрытое: карточка по Enter/тапу скрывается или
 * возвращается; можно найти и добавить фильм или сериал вручную; «Обновить состав» просит сервер пересобрать.
 * Выбор пользователя сильнее автоматики: скрытое им не вернётся при обновлении.
 */

var ACTION_ICONS = {
    gear: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    all: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>',
    film: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 5v14M16 5v14M4 9.5h4M16 9.5h4M4 14.5h4M16 14.5h4"/>',
    tv: '<rect x="3.5" y="7" width="17" height="12" rx="2"/><path d="M8 3l4 4 4-4"/>',
    cartoon: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 14c1 1.7 2.3 2.5 3.7 2.5s2.7-.8 3.7-2.5M9 9.5h.01M15 9.5h.01"/>',
    anime: '<path d="M12 3l2.1 5.6 5.9.3-4.6 3.7 1.6 5.7-5-3.3-5 3.3 1.6-5.7L4 8.9l5.9-.3z"/>',
    docs: '<path d="M6.5 3.5h8l3.5 3.5v13.5h-11.5z"/><path d="M14.5 3.5V7H18M9.5 11.5h5M9.5 15h5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    trash: '<path d="M5 7h14M9.5 7V4.5h5V7M7 7l1 12.5h8L17 7M10.5 10.5v6M13.5 10.5v6"/>',
    refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5M19.5 4.5V9H15"/>'
};

// Кнопка-плитка в сетке: обычная карточка Lampa (её берёт фокус и пульт), внутри значок вместо постера.
function actionTile(id, icon, label, onEnter, active) {
    return {
        id: id,
        media_type: 'movie',
        title: label, original_title: label, release_date: '', vote_average: 0, overview: '',
        poster_path: null, backdrop_path: null,
        source: 'tapokhub',
        params: {
            emit: {
                onCreate: function () {
                    if (!this.html || !this.html.addClass) return;

                    this.html.addClass('tapokhub-action');
                    if (active) this.html.addClass('tapokhub-action--on');   // выбранный фильтр

                    // this.html — обычный DOM-элемент с добавками Lampa: find() отдаёт один элемент (или null), append() принимает только узел
                    var view = this.html.find ? this.html.find('.card__view') : null;

                    if (view) {
                        var body = document.createElement('div');

                        body.className = 'tapokhub-action__body';
                        body.innerHTML = '<svg viewBox="0 0 24 24">' + ACTION_ICONS[icon] + '</svg>';
                        view.appendChild(body);
                    }
                },
                onlyEnter: onEnter
            }
        }
    };
}

// Обычная карточка коллекции: долгое нажатие (меню карточки Lampa) добавляет пункт «Убрать из коллекции».
// Убранное не возвращается при обновлении состава; вернуть можно в режиме «Настроить» (карточка помечена «СКРЫТО»).
function removableCard(fid, c) {
    var card = TH.card(c, c.media_type);

    card.params.emit.onMenu = function (menu) {
        menu.push({ title: 'TapokHub', separator: true });
        menu.push({
            title: TH.t('Убрать из коллекции'),
            onSelect: function () {
                TH.lib.hideItem(fid, c.media_type, c.id, true, function (err) {
                    if (err) return Lampa.Noty.show(TH.t('Не удалось убрать, повторите'));

                    Lampa.Noty.show(TH.t('Убрано из коллекции. Вернуть: Настроить'));
                    Lampa.Activity.replace({});   // перечитать состав
                });
            }
        });
    };

    return card;
}

// Обычная карточка в режиме настройки: по Enter скрывается/возвращается, без перехода на страницу фильма
function settingsCard(fid, c) {
    var card = TH.card(c, c.media_type, { background: false });
    var state = { hidden: !!c.hidden };
    var html = null;
    var busy = false;

    function paint() {
        if (!html) return;

        html.toggleClass('tapokhub-off', state.hidden);

        var badge = html.find('.tapokhub-badge');
        var view = html.find('.card__view');

        if (badge) badge.remove();

        var text = state.hidden ? TH.t('СКРЫТО') : (c.source === 'manual' ? TH.t('ДОБАВЛЕНО') : '');

        if (text && view) {
            var mark = document.createElement('div');

            mark.className = 'tapokhub-badge' + (state.hidden ? ' tapokhub-badge--off' : '');
            mark.textContent = text;
            view.appendChild(mark);
        }
    }

    card.params.emit.onCreate = function () {
        html = this.html;
        if (html && html.addClass) html.addClass('tapokhub-card');
        if (html && html.toggleClass) paint();
    };

    card.params.emit.onlyEnter = function () {
        if (busy) return;

        busy = true;
        TH.lib.hideItem(fid, c.media_type, c.id, !state.hidden, function (err) {
            busy = false;

            if (err) return Lampa.Noty.show(TH.t('Не удалось сохранить, повторите'));

            state.hidden = !state.hidden;
            paint();
        });
    };

    return card;
}

// Что добавить: только выбранное, всю его коллекцию TMDB или всё связанное (франшиза целиком)
function chooseScope(fid, r) {
    var prev = Lampa.Controller.enabled().name;
    var name = r.title || r.name;

    function add(scope) {
        TH.lib.addToFranchise(fid, r.media_type, r.id, scope, function (e) {
            if (e) return Lampa.Noty.show(TH.t('Не удалось добавить'));

            Lampa.Noty.show(scope === 'related' ? TH.t('Ищу связанное, оно появится в коллекции позже') : TH.t('Добавлено'));
            Lampa.Activity.replace({});   // перечитать состав
        });
    }

    TH.lib.addOptions(fid, r.media_type, r.id, function (err, opts) {
        var items = [{ title: TH.t('Только «') + name + '»', scope: 'item' }];

        if (!err && opts && opts.collection) {
            items.push({ title: TH.t('Вся коллекция «') + opts.collection.name + '» (' + opts.collection.count + ' ' + TH.lib.plural(opts.collection.count, [TH.t('часть'), TH.t('части'), TH.t('частей')]) + ')', scope: 'collection' });
        }

        items.push({ title: TH.t('Всё связанное: франшиза целиком (поиск займёт время)'), scope: 'related' });

        Lampa.Select.show({
            title: TH.t('Что добавить в коллекцию'),
            items: items,
            onSelect: function (item) {
                Lampa.Controller.toggle(prev);
                add(item.scope);
            },
            onBack: function () { Lampa.Controller.toggle(prev); }
        });
    });
}

function searchToAdd(fid) {
    var prev = Lampa.Controller.enabled().name;

    Lampa.Input.edit({ title: TH.t('Название фильма или сериала'), value: '', free: true, nosave: true }, function (text) {
        Lampa.Controller.toggle(prev);

        text = String(text || '').trim();

        if (!text) return;

        TH.lib.search(text, function (err, data) {
            var found = (data && data.results) || [];

            if (err || !found.length) return Lampa.Noty.show(err ? TH.t('Поиск недоступен') : TH.t('Ничего не найдено'));

            Lampa.Select.show({
                title: TH.t('Добавить в коллекцию'),
                items: found.map(function (r) {
                    var year = String(r.release_date || r.first_air_date || '').slice(0, 4);

                    return { title: (r.title || r.name) + (year ? ' (' + year + ')' : '') + (r.media_type === 'tv' ? TH.t(', сериал') : ''), result: r };
                }),
                onSelect: function (item) {
                    Lampa.Controller.toggle(prev);
                    chooseScope(fid, item.result);
                },
                onBack: function () { Lampa.Controller.toggle(prev); }
            });
        });
    });
}

// Спросить подтверждение и удалить коллекцию. done(true) — удалена
function confirmDelete(fid, title, done) {
    var prev = Lampa.Controller.enabled().name;

    Lampa.Select.show({
        title: TH.t('Удалить коллекцию «') + title + '»?',
        items: [{ title: TH.t('Да, удалить'), yes: true }, { title: TH.t('Нет, оставить') }],
        onSelect: function (item) {
            Lampa.Controller.toggle(prev);

            if (!item.yes) return done && done(false);

            TH.lib.deleteFranchise(fid, function (err) {
                if (err) {
                    Lampa.Noty.show(TH.t('Не удалось удалить коллекцию'));

                    return done && done(false);
                }

                Lampa.Noty.show(TH.t('Коллекция «') + title + TH.t('» удалена'));
                if (done) done(true);
            });
        },
        onBack: function () { Lampa.Controller.toggle(prev); if (done) done(false); }
    });
}

// Настройки -> TapokHub -> «Удалить коллекцию»: выбрать из списка (в том числе зависшие и собираемые) и подтвердить
TH.collectionsDelete = function () {
    var prev = Lampa.Controller.enabled().name;

    TH.lib.franchises(function (err, data) {
        var list = (data && data.franchises || []).filter(function (f) { return !f.merged_into; });

        if (err || !list.length) return Lampa.Noty.show(err ? TH.t('Список коллекций недоступен') : TH.t('Коллекций нет'));

        Lampa.Select.show({
            title: TH.t('Какую коллекцию удалить?'),
            items: list.map(function (f) {
                var n = (f.counts && f.counts.visible) || 0;
                var note = f.status === 'ready' ? n + ' ' + TH.lib.plural(n, [TH.t('позиция'), TH.t('позиции'), TH.t('позиций')]) : (f.status === 'error' ? TH.t('ошибка сборки') : TH.t('собирается'));

                return { title: f.title + ' · ' + note, f: f };
            }),
            onSelect: function (item) {
                Lampa.Controller.toggle(prev);
                confirmDelete(item.f.id, item.f.title);
            },
            onBack: function () { Lampa.Controller.toggle(prev); }
        });
    });
};

function FranchiseScreen(object) {
    var settings = !!object.settings;

    return GridScreen(gridParams(object, 6), function (done) {
        TH.lib.franchise(object.franchise_id, settings, function (err, data) {
            if (err || !data || !data.groups || !data.groups.length) return done([]);

            var fid = data.id;
            var actions;

            if (settings) {
                actions = [
                    actionTile(900000101, 'check', TH.t('Готово'), function () { Lampa.Activity.replace({ settings: false }); }),
                    actionTile(900000102, 'plus', TH.t('Добавить фильм или сериал'), function () { searchToAdd(fid); }),
                    actionTile(900000103, 'refresh', TH.t('Обновить состав'), function () {
                        TH.lib.refreshFranchise(fid, function (e) {
                            Lampa.Noty.show(e ? TH.t('Не удалось запустить обновление') : TH.t('Обновляю состав, загляните позже'));
                        });
                    }),
                    actionTile(900000104, 'trash', TH.t('Удалить коллекцию'), function () {
                        confirmDelete(fid, data.title, function (deleted) { if (deleted) Lampa.Activity.backward(); });
                    })
                ];
            } else {
                actions = [actionTile(900000100, 'gear', TH.t('Настроить'), function () { Lampa.Activity.replace({ settings: true }); })];
            }

            var sections = [{
                title: settings ? TH.t('Настройка: нажмите на карточку, чтобы скрыть её или вернуть') : '',
                cards: actions,
                actions: true,
                hero: { title: data.title, logo: data.logo }   // шапка: название франшизы логотипом (нет логотипа — текстом)
            }];

            data.groups.forEach(function (g) {
                var hiddenNote = settings && g.hidden_count ? TH.t(' · скрыто: ') + g.hidden_count : '';

                sections.push({
                    title: g.title + hiddenNote,
                    cards: g.items.map(function (c) { return settings ? settingsCard(fid, c) : removableCard(fid, c); })
                });
            });

            done(sections);
        });
    });
}
