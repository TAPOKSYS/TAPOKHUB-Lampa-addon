/* ---------- Регистрация на сервере: открытая или закрытая ----------
 *
 * Открытая: войти через аккаунт CUB может любой, его почта регистрируется сама. Закрытая: входят только те, кого
 * администратор добавил (`tapokhub users add`). Значение хранится на сервере; видеть и менять его может только владелец
 * сервера (первый пользователь), остальным строка сообщает, кто это настраивает.
 */
TH.registration = (function () {
    var last = null;        // последний ответ сервера: { admin, open? }
    var descr = null;

    function noty(text) {
        try { Lampa.Noty.show(text); } catch (e) { /* без уведомления обойдёмся */ }
    }

    function explain(err) {
        if (!err) return '';
        if (err.status === 0) return TH.t('нет связи с сервером');
        if (err.status === 404) return TH.t('сервер не принял вход, войдите заново в разделе «Авторизация»');
        if (err.status === 403) return TH.t('регистрацию меняет только владелец сервера');
        return err.message || TH.t('сервер вернул ошибку ') + err.status;
    }

    function describe(s) {
        if (!s) return '';
        if (!s.admin) return TH.t('Настраивает владелец сервера');

        return s.open ? TH.t('Открытая: войти может любой владелец аккаунта CUB') :
            TH.t('Закрытая: входят только добавленные администратором почты');
    }

    function refresh() {
        if (!descr) return;

        if (!TH.lib.enabled()) return descr.text(TH.t('Сначала войдите в разделе «Авторизация»'));

        descr.text(TH.t('Проверяю…'));
        TH.lib.request('GET', 'registration', null, function (err, s) {
            if (err) return descr.text(TH.t('Не удалось узнать: ') + explain(err));

            last = s || {};
            descr.text(describe(last));
        });
    }

    function save(open) {
        TH.lib.request('POST', 'registration', { open: open }, function (err, s) {
            if (err) noty('TapokHub: ' + explain(err));
            else {
                last = s || {};
                noty(open ? TH.t('TapokHub: регистрация открыта') : TH.t('TapokHub: регистрация закрыта'));
            }

            refresh();
        });
    }

    function choose() {
        if (!TH.lib.enabled()) return noty(TH.t('TapokHub: сначала войдите в разделе «Авторизация»'));
        if (!last) return noty(TH.t('TapokHub: ещё проверяю сервер, попробуйте через секунду'));
        if (!last.admin) return noty(TH.t('TapokHub: регистрацию меняет только владелец сервера'));

        var prev = Lampa.Controller.enabled().name;

        Lampa.Select.show({
            title: TH.t('Регистрация на сервере'),
            items: [
                { title: TH.t('Закрытая: только добавленные почты'), open: false, selected: !last.open },
                { title: TH.t('Открытая: любой владелец аккаунта CUB'), open: true, selected: !!last.open }
            ],
            onSelect: function (item) {
                Lampa.Controller.toggle(prev);

                if (item.open !== !!last.open) save(item.open);
            },
            onBack: function () { Lampa.Controller.toggle(prev); }
        });
    }

    function settings() {
        if (!window.Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addParam) return;

        Lampa.SettingsApi.addParam({
            component: 'tapokhub',
            param: { name: 'tapokhub_registration', type: 'button' },
            field: { name: TH.t('Регистрация на сервере'), description: TH.t('Открытая или закрытая. Меняет только владелец сервера') },
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
