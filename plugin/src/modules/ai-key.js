/* ---------- Ключ ИИ для подборки дня ----------
 *
 * Подборку «Подборка дня от ИИ» сервер собирает через OpenAI-совместимый API (по умолчанию DeepSeek). Ключ владелец вводит
 * здесь: он уходит на сервер и там хранится, обратно в Lampa не возвращается (видны только последние четыре символа).
 * Видеть и менять ключ может только владелец сервера (первый пользователь).
 */
TH.aiKey = (function () {
    var last = null;        // последний ответ сервера: { admin, set, source, hint, day, error, busy }
    var descr = null;

    function noty(text) {
        try { Lampa.Noty.show(text); } catch (e) { /* без уведомления обойдёмся */ }
    }

    function explain(err) {
        if (!err) return '';
        if (err.status === 0) return TH.t('нет связи с сервером');
        if (err.status === 404) return TH.t('сервер не принял вход, войдите заново в разделе «Авторизация»');
        if (err.status === 403) return TH.t('ключ ИИ задаёт только владелец сервера');
        return err.message || TH.t('сервер вернул ошибку ') + err.status;
    }

    function describe(s) {
        if (!s) return '';
        if (!s.admin) return TH.t('Настраивает владелец сервера');
        if (!s.set) return TH.t('Не задан: подборка дня от ИИ выключена');

        var text = TH.t('Задан: …') + s.hint + (s.source === 'server' ? TH.t(' (в настройках сервера)') : '');

        if (s.busy) return text + TH.t(' · подборка собирается…');
        if (s.error) return text + TH.t(' · последняя попытка не удалась: ') + s.error;

        return s.day ? text + TH.t(' · подборка от ') + s.day : text;
    }

    function refresh() {
        if (!descr) return;

        if (!TH.lib.enabled()) return descr.text(TH.t('Сначала войдите в разделе «Авторизация»'));

        descr.text(TH.t('Проверяю…'));
        TH.lib.request('GET', 'ai-key', null, function (err, s) {
            if (err) return descr.text(TH.t('Не удалось узнать: ') + explain(err));

            last = s || {};
            descr.text(describe(last));
        });
    }

    function save(key) {
        TH.lib.request('POST', 'ai-key', { key: key }, function (err, s) {
            if (err) noty('TapokHub: ' + (err.status === 400 ? TH.t('это не похоже на ключ ИИ') : explain(err)));
            else {
                last = s || {};
                noty(key ? TH.t('TapokHub: ключ ИИ сохранён, подборка собирается') : TH.t('TapokHub: ключ ИИ убран'));
            }

            refresh();
        });
    }

    function enter(prev) {
        Lampa.Input.edit({ title: TH.t('Ключ ИИ (DeepSeek), вида sk-…'), value: '', free: true, nosave: true }, function (value) {
            Lampa.Controller.toggle(prev);

            if (value) save(String(value).replace(/\s+/g, ''));
        });
    }

    function choose() {
        if (!TH.lib.enabled()) return noty(TH.t('TapokHub: сначала войдите в разделе «Авторизация»'));
        if (!last) return noty(TH.t('TapokHub: ещё проверяю сервер, попробуйте через секунду'));
        if (!last.admin) return noty(TH.t('TapokHub: ключ ИИ задаёт только владелец сервера'));

        var prev = Lampa.Controller.enabled().name;

        if (!last.set) return enter(prev);

        Lampa.Select.show({
            title: TH.t('Ключ ИИ для подборки'),
            items: [
                { title: TH.t('Ввести другой ключ'), act: 'enter' },
                { title: TH.t('Убрать ключ'), act: 'clear' }
            ],
            onSelect: function (item) {
                if (item.act === 'enter') return enter(prev);

                Lampa.Controller.toggle(prev);
                save('');
            },
            onBack: function () { Lampa.Controller.toggle(prev); }
        });
    }

    function settings() {
        if (!window.Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addParam) return;

        Lampa.SettingsApi.addParam({
            component: 'tapokhub',
            param: { name: 'tapokhub_ai_key', type: 'button' },
            field: { name: TH.t('Ключ ИИ для подборки'), description: TH.t('DeepSeek или другой совместимый сервис. Хранится на сервере, меняет только владелец') },
            onRender: function (item) {
                descr = $('<div class="settings-param__descr"></div>');
                item.append(descr);
                last = null;
                refresh();
            },
            onChange: choose
        });
    }

    return { settings: settings, describe: describe, explain: explain, save: save };
})();
