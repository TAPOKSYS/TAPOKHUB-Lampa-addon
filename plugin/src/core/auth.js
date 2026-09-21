/*
 * Вход в TapokHub: у каждого устройства свой токен, у токена свой пользователь и своя библиотека.
 *
 * Токен получают двумя способами:
 * 1. Через аккаунт CUB, в который уже вошла Lampa (cub.best, зеркала, bylampa): плагин отправляет серверу токен
 *    аккаунта, сервер спрашивает у CUB, чья это почта, и, если её добавил администратор, выдаёт токен устройства.
 *    Токен аккаунта сервер не хранит; в самом плагине хранится только токен устройства.
 * 2. Вручную: администратор выдаёт токен командой `users token`, его вводят в Настройки -> TapokHub.
 *
 * Без токена плагин работает как обычная Lampa: подмены TMDB и библиотека выключены.
 */

TH.auth = (function () {
    var KEY = 'tapokhub_token';
    var SERVER = 'tapokhub_server_url';      // адрес сервера в общей сборке (TH.universal), вводится в настройках
    var HINTED = 'tapokhub_server_hinted';
    var attempt = 0;
    var ASKED = 'tapokhub_login_denied_at';
    var TRUSTED = 'tapokhub_cub_trusted';       // адрес, которому человек разрешил получить токен аккаунта CUB
    var QUIET = 12 * 3600 * 1000;      // об отказе входа напоминаем не чаще, чем раз в полдня

    // Адрес сервера: вшитый в сборку, а в общей сборке (TH.universal) введённый человеком
    function host() {
        if (baked()) return String(TH.proxyHost).replace(/\/+$/, '');

        if (!TH.universal) return '';

        try { return String(Lampa.Storage.get(SERVER, '') || '').replace(/\/+$/, ''); } catch (e) { return ''; }
    }

    // Адрес вшит в сборку плагина (плагин взят с самого сервера или собран под него)
    function baked() {
        var h = TH.proxyHost;

        return !!h && h.indexOf('@@') !== 0;
    }

    // Можно ли этому серверу слать токен аккаунта CUB без вопроса: адрес вшит в сборку или человек уже подтвердил именно его
    function trusted() {
        if (baked() || !TH.universal) return true;

        try { return Lampa.Storage.get(TRUSTED, '') === host(); } catch (e) { return false; }
    }

    // Токен аккаунта CUB открывает аккаунт целиком, а проверка /healthz подделывается любым сервером. Поэтому на адрес,
    // введённый руками, токен уходит только после явного согласия. next() вызывается, когда можно.
    function confirmCub(next) {
        if (trusted()) return next();

        var prev = Lampa.Controller.enabled().name;
        var addr = host();
        var plain = /^http:/i.test(addr);

        Lampa.Select.show({
            title: TH.t('Отправить серверу токен аккаунта CUB?') + ' ' + addr,
            items: [
                { title: TH.t('Отправить и войти'), ok: true },
                { title: TH.t('Не отправлять'), ok: false, selected: true },
                { title: TH.t('Сервер узнает вашу почту и получит доступ к аккаунту CUB. Входите только на сервер, которому доверяете') + (plain ? TH.t('. Адрес без https: токен идёт по сети открыто') : ''), ok: false, disabled: true }
            ],
            onSelect: function (item) {
                Lampa.Controller.toggle(prev);

                if (!item.ok) return;

                try { Lampa.Storage.set(TRUSTED, addr); } catch (e) { TH.log('trust not saved', e && e.message); }

                next();
            },
            onBack: function () { Lampa.Controller.toggle(prev); }
        });
    }

    // Введённый адрес -> 'https://хост[:порт]' или '' (неверный). Без схемы считаем https; хвост «/tapokhub.js» и слэши убираем.
    function normalizeServer(input) {
        var s = String(input || '').trim().replace(/\/tapokhub\.js.*$/i, '').replace(/\/+$/, '');

        if (!s) return '';

        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;

        return /^https?:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/.test(s) ? s : '';
    }

    // Проверить, что по адресу отвечает TapokHub (/healthz без токена). done(ошибка | null)
    function checkServer(addr, done) {
        TH.lib.transport('GET', addr + '/healthz', null, function (err, data) {
            if (err) {
                var https = typeof location !== 'undefined' && location.protocol === 'https:';

                return done(err.status === 0 && https && /^http:/i.test(addr) ? { status: 0, message: 'mixed' } : err);
            }

            done(data && data.ok && data.version ? null : { status: 0, message: 'not tapokhub' });
        });
    }

    // Общая сборка: сохранить адрес сервера после проверки. Токен прежнего сервера сбрасывается, входим заново.
    // done(ошибка | null, адрес)
    function setServer(input, done) {
        var addr = normalizeServer(input);

        if (!addr) return done({ status: 0, message: 'bad address' }, null);

        checkServer(addr, function (err) {
            if (err) return done(err, null);

            var changed = addr !== host();

            try { Lampa.Storage.set(SERVER, addr); } catch (e) { TH.log('server not saved', e && e.message); }

            if (changed) {
                attempt++;
                save('');
            }

            apply();

            if (TH.homeCss) TH.homeCss();      // картинка хаба берётся с этого сервера

            done(null, addr);
        });
    }

    function token() {
        try { return String(Lampa.Storage.get(KEY, '') || ''); } catch (e) { return ''; }
    }

    function base() {
        var h = host();
        var t = token();

        return h && t ? h + '/tmdb/' + encodeURIComponent(t) : '';
    }

    // Применить текущий токен: включить или выключить подмены TMDB и библиотеку
    function apply() {
        TH.proxy.configure(base());
    }

    function save(value) {
        try { Lampa.Storage.set(KEY, value || ''); } catch (e) { TH.log('token not saved', e && e.message); }
    }

    function noty(text) {
        try { Lampa.Noty.show(text); } catch (e) { /* без уведомления обойдёмся */ }
    }

    // done(ошибка | null, { id, name, email })
    function whoami(done) {
        if (!base()) return done({ status: 0, message: 'no token' }, null);

        TH.lib.transport('GET', base() + '/whoami', null, done);
    }

    // Обмен аккаунта CUB на токен устройства. done(ошибка | null, пользователь)
    function loginCub(done) {
        var permit = window.Lampa && Lampa.Account && Lampa.Account.Permit;

        if (!host()) return done({ status: 0, message: 'no host' }, null);
        if (!permit || !permit.token) return done({ status: 401, message: 'no cub account' }, null);

        var requestAttempt = ++attempt;
        var body = {
            domain: Lampa.Manifest.cub_domain,
            token: permit.token,
            profile: (permit.profile && permit.profile.id) || '',
            device: String(Lampa.Storage.get('device_name', '') || '')
        };

        TH.lib.transport('POST', host() + '/tmdb/auth/cub', body, function (err, data) {
            if (requestAttempt !== attempt) return;
            if (err || !data || !data.token) return done(err || { status: 0, message: 'bad answer' }, null);

            save(data.token);
            apply();
            if (TH.play) TH.play.sync(true);     // на новом устройстве сразу подтянуть выбранные торренты
            if (TH.sync) TH.sync.pull(true);     // и настройки плагина
            done(null, data.user || {});
        });
    }

    // Ввод токена руками. Проверяем на сервере; неверный токен не сохраняем.
    function setToken(value, done) {
        var candidate = String(value || '').trim();
        var requestAttempt = ++attempt;
        if (!host() || !candidate) return done({ status: 0, message: 'no token' }, null);
        // Проверяем новый токен, не переключая работающий аккаунт до успеха.
        TH.lib.transport('GET', host() + '/tmdb/' + encodeURIComponent(candidate) + '/whoami', null, function (err, user) {
            if (requestAttempt !== attempt) return;
            if (!err) {
                save(candidate);
                apply();
                if (TH.play) TH.play.sync(true);
                if (TH.sync) TH.sync.pull(true);
            }
            done(err, user);
        });
    }

    function logout() {
        attempt++;
        save('');
        apply();
    }

    // Понятное описание причины отказа
    function explain(err) {
        var status = err && err.status;

        if (status === 403) return (err.message ? err.message : TH.t('доступ закрыт')) + '';
        if (status === 401) return TH.t('в Lampa не выполнен вход в аккаунт CUB');
        if (status === 429) return TH.t('слишком много попыток, подождите несколько минут');
        if (status === 404) return TH.t('сервер не узнал токен');
        if (status === 424) return TH.t('сервер не смог получить ответ от CUB') + (err.message ? ' (' + err.message + ')' : '');
        if (status === 400) return TH.t('сервер не принял запрос') + (err.message ? ' (' + err.message + ')' : '');
        if (status === 0 && err.message === 'network') return TH.t('нет связи с сервером (сеть или блокировка запроса)');
        if (status === 0 && err.message === 'bad address') return TH.t('адрес неверен, пример: https://tapok.example.com');
        if (status === 0 && err.message === 'not tapokhub') return TH.t('по этому адресу нет сервера TapokHub');
        if (status === 0 && err.message === 'mixed') return TH.t('Lampa открыта по https, а сервер по http: браузер такое блокирует. Нужен адрес с https');

        return TH.t('сервер недоступен');
    }

    // Запуск: применить сохранённый токен; нет его, а Lampa вошла в CUB: один раз тихо войти по аккаунту
    function init() {
        if (TH.proxyBase && TH.proxyBase.indexOf('@@') !== 0) return TH.proxy.configure(TH.proxyBase);   // сборка с вшитым адресом (личная)

        apply();

        if (TH.universal && !host()) {
            hintServer();
            return;
        }

        autoLogin();
    }

    // Общая сборка без адреса: один раз подсказать, куда его ввести
    function hintServer() {
        try {
            if (Lampa.Storage.get(HINTED, false)) return;

            Lampa.Storage.set(HINTED, true);
        } catch (e) { /* подскажем ещё раз, не страшно */ }

        noty(TH.t('TapokHub: укажите адрес своего сервера в Настройки → TapokHub → «Ввести адрес сервера вручную»'));
    }

    // Нет токена, а Lampa вошла в CUB: один раз тихо войти по аккаунту (не чаще, чем раз в QUIET после отказа).
    // Адрес, введённый руками и ещё не подтверждённый, тихо не трогаем: ask=true (сразу после ввода адреса) спрашивает согласие.
    function autoLogin(ask) {
        if (token() || !host()) return;

        var permit = window.Lampa && Lampa.Account && Lampa.Account.Permit;

        if (!permit || !permit.token) return;

        var denied = Number(Lampa.Storage.get(ASKED, 0)) || 0;

        if (denied && Date.now() - denied < QUIET) return;

        if (!ask && !trusted()) return;

        confirmCub(function () {
            loginCub(function (err, user) {
                if (!err) return noty(TH.t('TapokHub: вход выполнен') + (user && user.email ? ' (' + user.email + ')' : ''));

                if (err.status === 403 || err.status === 429) {
                    try { Lampa.Storage.set(ASKED, Date.now()); } catch (e) { /* не страшно */ }
                    noty('TapokHub: ' + explain(err));
                }
            });
        });
    }

    // Раздел «TapokHub» в настройках Lampa: список пунктов, каждый открывает свою страницу (Авторизация, Анимация...)
    var MAIN = 'tapokhub';

    // Значок раздела: белая обводка, как у остальных значков настроек Lampa (без обводки был бы чёрный квадрат)
    var ICON = '<svg width="39" height="39" viewBox="0 0 39 39" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="3.5" y="10.5" width="32" height="22" rx="4.5" stroke="white" stroke-width="3"/>' +
        '<path d="M16 16.5v10l8.5-5z" fill="white"/>' +
        '<path d="M13 4.5l6.5 6 6.5-6" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    // Страница настроек, которой нет в общем списке: только шаблон и параметры (addComponent добавил бы её в список)
    function page(name, title) {
        if (!Lampa.Template.get || !Lampa.Template.add) return;

        Lampa.Template.add('settings_' + name, '<div></div>');
        Lampa.SettingsApi.addParam({ component: name, param: { type: 'title' }, field: { name: title } });
    }

    // back — страница, на которую вернёт «Назад» (по умолчанию главная страница раздела)
    function open(name, back) {
        Lampa.Settings.create(name, { onBack: function () { Lampa.Settings.create(back || MAIN); } });
    }

    TH.settingsPage = page;

    // Заголовок группы на странице настроек (нативный param type 'title'): разделяет пункты, чтобы страница не была кучей
    TH.settingsTitle = function (component, name) {
        Lampa.SettingsApi.addParam({ component: component, param: { type: 'title' }, field: { name: name } });
    };
    TH.settingsOpen = open;

    // Общая сборка: ввод адреса сервера (вручную или из буфера обмена)
    function serverParams() {
        function connected(err, addr) {
            if (err) return noty('TapokHub: ' + explain(err));

            noty(TH.t('TapokHub: сервер подключён') + ' (' + addr + ')');

            autoLogin(true);
        }

        Lampa.SettingsApi.addParam({
            component: MAIN,
            param: { name: 'tapokhub_server_paste', type: 'button' },
            field: { name: TH.t('Вставить адрес сервера из буфера обмена'), description: TH.t('Адрес вашего сервера TapokHub, например https://tapok.example.com. Скопируйте его и нажмите сюда') },
            onChange: function () {
                TH.clipboard(function (err, text) {
                    if (err || !text) return noty(TH.t('TapokHub: не удалось прочитать буфер обмена, введите адрес вручную'));

                    setServer(text, connected);
                });
            }
        });

        Lampa.SettingsApi.addParam({
            component: MAIN,
            param: { name: 'tapokhub_server_input', type: 'button' },
            field: { name: TH.t('Ввести адрес сервера вручную'), description: TH.t('Адрес проверяется, при смене сервера вход на прежнем сбрасывается') },
            onChange: function () {
                var prev = Lampa.Controller.enabled().name;

                Lampa.Input.edit({ title: TH.t('Адрес сервера TapokHub'), value: host(), free: true, nosave: true }, function (value) {
                    Lampa.Controller.toggle(prev);

                    if (value) setServer(value, connected);
                });
            }
        });
    }

    function settings() {
        if (!window.Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addComponent) return;

        var descr = null;

        // Нет адреса: в общей сборке его вводят в настройках, во вшитой он задан при сборке
        function unset() {
            return TH.universal ? TH.t('Адрес сервера не указан') : TH.t('Сервер не указан в этой сборке плагина');
        }

        function refreshStatus() {
            if (!descr) return;

            if (!host()) return descr.text(unset());
            if (!token()) return descr.text(TH.t('Вход не выполнен'));

            descr.text(TH.t('Проверяю…'));
            whoami(function (err, user) {
                if (err) return descr.text(TH.t('Токен сохранён, но сервер сейчас не отвечает или не принимает его'));

                descr.text(TH.t('Вход выполнен: ') + ((user && (user.email || user.name)) || TH.t('пользователь')));
            });
        }

        function done(err, user) {
            if (err) noty('TapokHub: ' + explain(err));
            else noty(TH.t('TapokHub: вход выполнен') + (user && user.email ? ' (' + user.email + ')' : ''));

            refreshStatus();
        }

        Lampa.SettingsApi.addComponent({ component: MAIN, name: 'TapokHub', icon: ICON, after: 'more' });

        // --- главная страница, по группам: Подключение, Главный экран, Просмотр и библиотека, Уведомления, Сервер, О плагине
        function button(name, target, title, text) {
            Lampa.SettingsApi.addParam({
                component: MAIN,
                param: { name: name, type: 'button' },
                field: { name: title, description: text },
                onChange: function () { open(target); }
            });
        }

        TH.settingsTitle(MAIN, TH.t('Подключение'));

        // какой сервер отвечает: его версия
        Lampa.SettingsApi.addParam({
            component: MAIN,
            param: { name: 'tapokhub_server', type: 'static' },
            field: { name: TH.t('Сервер') },
            onRender: function (item) {
                var line = $('<div class="settings-param__descr"></div>');

                item.append(line);

                if (!host()) return line.text(unset());

                if (TH.universal) item.find('.settings-param__name').text(TH.t('Сервер') + ': ' + host());

                if (!token()) return line.text(TH.t('Вход не выполнен'));

                line.text(TH.t('Проверяю…'));
                TH.lib.transport('GET', base() + '/health', null, function (err, json) {
                    if (err || !json || !json.ok) return line.text(TH.t('Не отвечает или не принимает токен'));

                    line.text(TH.t('Версия ') + (json.version || '?'));
                });
            }
        });

        if (TH.universal) serverParams();   // «Адрес сервера»: только в общей сборке

        button('tapokhub_open_auth', 'tapokhub_auth', TH.t('Авторизация'), TH.t('Вход через аккаунт CUB или по токену, выход'));

        TH.settingsTitle(MAIN, TH.t('Главный экран'));
        button('tapokhub_open_anim', 'tapokhub_anim', TH.t('Анимация'), TH.t('Счётчики, помехи телевизора, видеомагнитофон'));
        TH.autostart.settings();     // «Запускать хаб при старте Lampa»

        TH.settingsTitle(MAIN, TH.t('Просмотр и библиотека'));
        button('tapokhub_open_play', 'tapokhub_play', TH.t('Воспроизведение'), TH.t('Автозапуск выбранного торрента, поиск другого через парсер'));

        // не страница, а сразу действие: выбрать коллекцию и удалить
        Lampa.SettingsApi.addParam({
            component: MAIN,
            param: { name: 'tapokhub_delete_collection', type: 'button' },
            field: { name: TH.t('Удалить коллекцию'), description: TH.t('Выбрать коллекцию из списка и удалить (после подтверждения). Просмотренное и добавленные по одному фильмы не затрагиваются') },
            onChange: function () { TH.collectionsDelete(); }
        });

        TH.settingsTitle(MAIN, TH.t('Уведомления'));
        button('tapokhub_open_tg', 'tapokhub_tg', 'Telegram', TH.t('Бот для добавления фильмов и сериалов в библиотеку: токен и чат'));

        TH.settingsTitle(MAIN, TH.t('Сервер: для владельца'));
        TH.registration.settings();  // «Регистрация на сервере»: открытая или закрытая (меняет владелец)

        TH.settingsTitle(MAIN, TH.t('О плагине'));
        Lampa.SettingsApi.addParam({
            component: MAIN,
            param: { name: 'tapokhub_version', type: 'static' },
            field: { name: TH.t('Версия'), description: TH.versionLabel }
        });

        // --- Авторизация
        page('tapokhub_auth', TH.t('Авторизация'));

        Lampa.SettingsApi.addParam({
            component: 'tapokhub_auth',
            param: { name: 'tapokhub_status', type: 'static' },
            field: { name: TH.t('Состояние') },
            onRender: function (item) {
                descr = $('<div class="settings-param__descr"></div>');
                item.append(descr);
                refreshStatus();
            }
        });

        TH.settingsTitle('tapokhub_auth', TH.t('Вход'));

        Lampa.SettingsApi.addParam({
            component: 'tapokhub_auth',
            param: { name: 'tapokhub_login_cub', type: 'button' },
            field: { name: TH.t('Войти через аккаунт CUB'), description: TH.t('Используется аккаунт, в который уже вошла Lampa (CUB, bylampa). Новая почта регистрируется автоматически') },
            onChange: function () { confirmCub(function () { loginCub(done); }); }
        });

        Lampa.SettingsApi.addParam({
            component: 'tapokhub_auth',
            param: { name: 'tapokhub_token_paste', type: 'button' },
            field: { name: TH.t('Вставить токен из буфера обмена'), description: TH.t('Скопируйте токен (например, из сообщения администратора) и нажмите сюда: печатать его не придётся') },
            onChange: function () {
                TH.clipboard(function (err, text) {
                    if (err || !text) return noty(TH.t('TapokHub: не удалось прочитать буфер обмена, введите токен вручную'));

                    if (/\s/.test(text)) return noty(TH.t('TapokHub: в буфере не токен, а обычный текст'));

                    setToken(text, done);
                });
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'tapokhub_auth',
            param: { name: 'tapokhub_token_input', type: 'button' },
            field: { name: TH.t('Ввести токен вручную'), description: TH.t('Токен выдаёт администратор сервера. Действует только на этом устройстве') },
            onChange: function () {
                var prev = Lampa.Controller.enabled().name;

                Lampa.Input.edit({ title: TH.t('Токен TapokHub'), value: '', free: true, nosave: true }, function (value) {
                    Lampa.Controller.toggle(prev);

                    if (value) setToken(value, done);
                });
            }
        });

        TH.settingsTitle('tapokhub_auth', TH.t('Выход'));

        Lampa.SettingsApi.addParam({
            component: 'tapokhub_auth',
            param: { name: 'tapokhub_logout', type: 'button' },
            field: { name: TH.t('Выйти на этом устройстве') },
            onChange: function () {
                logout();
                noty(TH.t('TapokHub: вы вышли'));
                refreshStatus();
            }
        });
    }

    return {
        host: host, setServer: setServer, normalizeServer: normalizeServer, token: token, base: base, apply: apply, whoami: whoami, loginCub: loginCub, setToken: setToken,
        trusted: trusted, confirmCub: confirmCub, autoLogin: autoLogin, logout: logout, explain: explain, init: init, settings: settings
    };
})();
