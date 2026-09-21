/* ---------- анимация (включается в настройках плагина) ---------- */

TH.anim = {
    countMs: 3200,   // за сколько миллисекунд счётчики добегают до значений (в тестах короче)
    counters: function () { return !!(window.Lampa && Lampa.Storage && Lampa.Storage.field('tapokhub_anim_counters')); },
    crt: function () { return !!(window.Lampa && Lampa.Storage && Lampa.Storage.field('tapokhub_anim_crt')); },
    vcr: function () { return !!(window.Lampa && Lampa.Storage && Lampa.Storage.field('tapokhub_anim_vcr')); }
};

// Параметры в разделе «TapokHub» настроек (сам раздел создаёт TH.auth.settings)
TH.animSettings = function () {
    if (!window.Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addParam || !TH.settingsPage) return;

    TH.settingsPage('tapokhub_anim', TH.t('Анимация главного экрана'));

    TH.settingsTitle('tapokhub_anim', TH.t('Экран хаба'));

    Lampa.SettingsApi.addParam({
        component: 'tapokhub_anim',
        param: { name: 'tapokhub_anim_counters', type: 'trigger', default: false },
        field: { name: TH.t('Счётчики набираются с нуля'), description: TH.t('Число фильмов, сериалов, коллекций и просмотренного растёт от нуля до значения при каждом входе') }
    });

    Lampa.SettingsApi.addParam({
        component: 'tapokhub_anim',
        param: { name: 'tapokhub_anim_vcr', type: 'trigger', default: false },
        field: { name: TH.t('Видеомагнитофон воспроизводит фильм'), description: TH.t('На дисплее горят значок и слово PLAY, вместо часов идёт время воспроизведения (минуты и секунды)') }
    });

    TH.settingsTitle('tapokhub_anim', TH.t('Помехи ЭЛТ'));

    Lampa.SettingsApi.addParam({
        component: 'tapokhub_anim',
        param: { name: 'tapokhub_anim_crt', type: 'trigger', default: false },
        field: { name: TH.t('Помехи на экране телевизора'), description: TH.t('Снег, бегущая полоса, мерцание и дрожание изображения, как на ЭЛТ-мониторе. На слабых устройствах лучше выключить') }
    });

    Lampa.SettingsApi.addParam({
        component: 'tapokhub_anim',
        param: { name: 'tapokhub_open_fx', type: 'button' },
        field: { name: TH.t('Область помех'), description: TH.t('Ровный прямоугольник: отступы, положение каждого угла, трапеция и выгиб сторон') },
        onChange: function () { TH.settingsOpen('tapokhub_fx', 'tapokhub_anim'); }
    });
};
