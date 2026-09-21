/* ---------- Telegram-бот: настройки ----------
 *
 * Сам бот работает на сервере (server/tapokhub/modules/telegram.py): ищет фильмы и сериалы, добавляет в библиотеку,
 * следит за коллекциями. Здесь только ввод токена бота (его выдаёт @BotFather) и привязка чата: после токена достаточно
 * написать боту /start, и сервер запомнит чат сам (окно 5 минут; страница это время следит за состоянием). Номер чата
 * можно и вписать, например для группы. Значения хранятся на сервере; на устройстве токен не остаётся, назад сервер
 * его не отдаёт, только «задан / не задан».
 */
TH.telegram = (function () {
    var PAGE = 'tapokhub_tg';
    var last = {};          // последнее состояние с сервера: подставляем номер чата в окно ввода
    var descr = null;
    var watchTimer = null;
    var cfg = { watchEvery: 3000, watchMax: 100 };     // пока идёт привязка, спрашиваем сервер раз в 3 секунды (не дольше окна в 5 минут)

    function noty(text) {
        try { Lampa.Noty.show(text); } catch (e) { /* без уведомления обойдёмся */ }
    }

    function explain(err) {
        if (!err) return '';
        if (err.status === 0) return TH.t('нет связи с сервером');
        if (err.status === 404) return TH.t('сервер не принял вход, войдите заново в разделе «Авторизация»');
        return err.message || TH.t('сервер вернул ошибку ') + err.status;
    }

    // Строка «Состояние»
    function describe(s) {
        if (!s || !s.token) return TH.t('Бот не подключён. Введите токен, который выдал @BotFather');

        var name = s.username ? '@' + s.username : TH.t('бот');

        if (!s.chat) return name + (s.pairing ? TH.t(' · ждёт: откройте бота в Telegram и отправьте ему /start (в течение 5 минут)') :
            TH.t(' · чат не привязан: нажмите «Привязать чат» и отправьте боту /start'));

        return name + TH.t(' · чат ') + s.chat + ' · ' + (s.running ? TH.t('работает') : TH.t('остановлен')) + (s.error ? ' (' + s.error + ')' : '');
    }

    // Пока сервер ждёт /start, следим за состоянием: как только чат привязался, говорим об этом
    function watch(left) {
        clearTimeout(watchTimer);
        watchTimer = null;

        if (!left || !last.pairing || !TH.lib.enabled()) return;

        watchTimer = setTimeout(function () {
            TH.lib.request('GET', 'telegram', null, function (err, s) {
                if (!err && s) {
                    var bound = !last.chat && s.chat;

                    last = s;
                    if (descr) descr.text(describe(last));
                    if (bound) noty(TH.t('TapokHub: чат привязан, бот готов. Напишите ему название фильма'));
                }

                watch(left - 1);
            });
        }, cfg.watchEvery);

        if (watchTimer && watchTimer.unref) watchTimer.unref();
    }

    function refresh() {
        if (!descr) return;

        if (!TH.lib.enabled()) return descr.text(TH.t('Сначала войдите в разделе «Авторизация»'));

        descr.text(TH.t('Проверяю…'));
        TH.lib.request('GET', 'telegram', null, function (err, s) {
            if (err) return descr.text(TH.t('Не удалось узнать состояние: ') + explain(err));

            last = s || {};
            descr.text(describe(last));
            watch(cfg.watchMax);
        });
    }

    // body: { token } | { chat } | { pair: true } | { clear: true }
    function save(body, done) {
        if (!TH.lib.enabled()) {
            noty(TH.t('TapokHub: сначала войдите в разделе «Авторизация»'));
            return done && done();
        }

        TH.lib.request('POST', 'telegram', body, function (err, s) {
            if (err) noty('TapokHub: ' + explain(err));
            else {
                last = s || {};

                if (body.clear) noty(TH.t('TapokHub: Telegram-бот отключён'));
                else if (s && s.token && s.pairing) noty(TH.t('TapokHub: готово. Теперь откройте бота в Telegram и отправьте ему /start, чат привяжется сам'));
                else if (s && s.token && s.chat) {
                    noty(s.test === 'ok' ? TH.t('TapokHub: бот подключён, в Telegram пришло сообщение') :
                        TH.t('TapokHub: бот подключён, но написать в чат не удалось (') + s.test + TH.t('). Откройте бота и нажмите Start'));
                } else noty(TH.t('TapokHub: сохранено'));
            }

            refresh();
            if (done) done(err, s);
        });
    }

    // Токен ищем внутри вставленного текста: можно скопировать сообщение от @BotFather целиком
    var TOKEN_IN_TEXT = /\d{5,15}:[A-Za-z0-9_-]{30,50}/;

    function tokenFrom(text) {
        var m = String(text || '').match(TOKEN_IN_TEXT);

        return m ? m[0] : '';
    }

    function chatFrom(text) {
        var t = String(text || '').trim();

        return /^-?\d{1,20}$/.test(t) ? t : '';
    }

    // Вставка из буфера; если буфер недоступен (телевизор, http), сразу открываем ручной ввод
    function paste(pick, what, body, manual) {
        TH.clipboard(function (err, text) {
            if (err || !text) {
                noty(TH.t('TapokHub: буфер обмена недоступен на этом устройстве, введите вручную'));
                return manual();
            }

            var value = pick(text);

            if (!value) return noty(TH.t('TapokHub: в буфере обмена нет ') + what);

            save(body(value));
        });
    }

    function ask(title, value, done) {
        var prev = Lampa.Controller.enabled().name;

        Lampa.Input.edit({ title: title, value: value || '', free: true, nosave: true }, function (text) {
            Lampa.Controller.toggle(prev);

            if (text !== undefined && String(text).trim()) done(String(text).trim());
        });
    }

    function settings() {
        if (!window.Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addParam || !TH.settingsPage) return;

        TH.settingsPage(PAGE, 'Telegram');

        Lampa.SettingsApi.addParam({
            component: PAGE,
            param: { name: 'tapokhub_tg_status', type: 'static' },
            field: { name: TH.t('Состояние') },
            onRender: function (item) {
                descr = $('<div class="settings-param__descr"></div>');
                item.append(descr);
                refresh();
            }
        });

        // к какому аккаунту привязаны настройки: пользователь на сервере создаётся по аккаунту CUB, поэтому бот общий для всех его устройств
        Lampa.SettingsApi.addParam({
            component: PAGE,
            param: { name: 'tapokhub_tg_account', type: 'static' },
            field: { name: TH.t('Аккаунт') },
            onRender: function (item) {
                var line = $('<div class="settings-param__descr"></div>');

                item.append(line);

                if (!TH.lib.enabled()) return line.text(TH.t('Сначала войдите в разделе «Авторизация»'));

                TH.auth.whoami(function (err, user) {
                    line.text(err ? TH.t('Не удалось узнать аккаунт') : TH.t('Привязано к аккаунту ') + ((user && (user.email || user.name)) || 'TapokHub') + TH.t(': бот и его настройки одни на все ваши устройства'));
                });
            }
        });

        var manualToken = function () { ask(TH.t('Токен Telegram-бота'), '', function (v) { save({ token: v }); }); };
        var manualChat = function () { ask(TH.t('Номер чата'), last.chat, function (v) { save({ chat: v }); }); };

        TH.settingsTitle(PAGE, TH.t('Токен бота'));

        Lampa.SettingsApi.addParam({
            component: PAGE,
            param: { name: 'tapokhub_tg_token_paste', type: 'button' },
            field: { name: TH.t('Вставить токен из буфера обмена'), description: TH.t('Скопируйте сообщение от @BotFather целиком или один токен и нажмите сюда. Хранится на сервере, на этом устройстве не сохраняется') },
            onChange: function () { paste(tokenFrom, TH.t('токена бота'), function (v) { return { token: v }; }, manualToken); }
        });

        Lampa.SettingsApi.addParam({
            component: PAGE,
            param: { name: 'tapokhub_tg_token', type: 'button' },
            field: { name: TH.t('Ввести токен вручную') },
            onChange: manualToken
        });

        TH.settingsTitle(PAGE, TH.t('Чат'));

        Lampa.SettingsApi.addParam({
            component: PAGE,
            param: { name: 'tapokhub_tg_pair', type: 'button' },
            field: { name: TH.t('Привязать чат'), description: TH.t('Нажмите, затем отправьте боту в Telegram /start: TapokHub запомнит ваш личный чат сам, номер вводить не нужно. Окно привязки открыто 5 минут; бот отвечает только в привязанном чате') },
            onChange: function () { save({ pair: true }); }
        });

        Lampa.SettingsApi.addParam({
            component: PAGE,
            param: { name: 'tapokhub_tg_chat_paste', type: 'button' },
            field: { name: TH.t('Вставить номер чата из буфера обмена'), description: TH.t('Для группы или если /start не подходит. Чтобы узнать номер, напишите боту /id и скопируйте ответ') },
            onChange: function () { paste(function (t) { return chatFrom(String(t).replace(/^[^-\d]*(-?\d+)[\s\S]*$/, '$1')); }, TH.t('номера чата'), function (v) { return { chat: v }; }, manualChat); }
        });

        Lampa.SettingsApi.addParam({
            component: PAGE,
            param: { name: 'tapokhub_tg_chat', type: 'button' },
            field: { name: TH.t('Ввести номер чата вручную') },
            onChange: manualChat
        });

        TH.settingsTitle(PAGE, TH.t('Отключение'));

        Lampa.SettingsApi.addParam({
            component: PAGE,
            param: { name: 'tapokhub_tg_off', type: 'button' },
            field: { name: TH.t('Отключить бота'), description: TH.t('Сервер забудет токен и чат, бот перестанет отвечать') },
            onChange: function () { save({ clear: true }); }
        });
    }

    return { config: cfg, settings: settings, describe: describe, explain: explain, save: save, tokenFrom: tokenFrom, chatFrom: chatFrom };
})();
