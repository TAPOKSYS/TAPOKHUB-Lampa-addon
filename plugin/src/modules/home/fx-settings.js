// Страницы настроек области помех: главная (пункты, показать, сбросить) и четыре страницы с числовыми полями
TH.fxSettings = function () {
    if (!window.Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addParam || !TH.settingsPage) return;

    var pages = [
        ['tapokhub_fx_pos', TH.t('Отступы'), TH.t('Отступы области от краёв стекла: сверху, снизу, слева, справа'), [
            ['left', TH.t('Слева, px'), TH.t('Отступ от левого края стекла. Отрицательное число выдвигает область за край')],
            ['right', TH.t('Справа, px'), TH.t('Отступ от правого края стекла')],
            ['top', TH.t('Сверху, px'), TH.t('Отступ от верхнего края стекла: больше число, ниже верх области')],
            ['bottom', TH.t('Снизу, px'), TH.t('Отступ от нижнего края стекла: больше число, выше низ области')]]],
        ['tapokhub_fx_corners', TH.t('Углы'), TH.t('Скругление и сдвиг каждого из четырёх углов по горизонтали (X) и вертикали (Y)'), [
            ['radius', TH.t('Скругление, px'), TH.t('0: острые углы; радиус дуги в каждом из четырёх углов')],
            ['tlx', TH.t('Левый верхний, X px'), TH.t('Плюс: вправо')], ['tly', TH.t('Левый верхний, Y px'), TH.t('Плюс: вниз')],
            ['trx', TH.t('Правый верхний, X px'), TH.t('Плюс: вправо')], ['try', TH.t('Правый верхний, Y px'), TH.t('Плюс: вниз')],
            ['blx', TH.t('Левый нижний, X px'), TH.t('Плюс: вправо')], ['bly', TH.t('Левый нижний, Y px'), TH.t('Плюс: вниз')],
            ['brx', TH.t('Правый нижний, X px'), TH.t('Плюс: вправо')], ['bry', TH.t('Правый нижний, Y px'), TH.t('Плюс: вниз')]]],
        ['tapokhub_fx_trap', TH.t('Трапеция'), TH.t('Сужение сторон: плюс делает сторону короче на это число с каждого конца, минус длиннее'), [
            ['nTop', TH.t('Верх, px'), TH.t('Плюс: верхняя сторона уже (трапеция, расширяющаяся книзу)')],
            ['nBottom', TH.t('Низ, px'), TH.t('Плюс: нижняя сторона уже')],
            ['nLeft', TH.t('Левая сторона, px'), TH.t('Плюс: левая сторона короче')],
            ['nRight', TH.t('Правая сторона, px'), TH.t('Плюс: правая сторона короче')]]],
        ['tapokhub_fx_bulge', TH.t('Выгиб сторон'), TH.t('Выгиб каждой стороны: середина стороны смещается на это число'), [
            ['bTop', TH.t('Верх, px'), TH.t('Плюс: наружу (вверх), минус: внутрь')],
            ['bBottom', TH.t('Низ, px'), TH.t('Плюс: наружу (вниз), минус: внутрь')],
            ['bLeft', TH.t('Лево, px'), TH.t('Плюс: наружу (влево), минус: внутрь')],
            ['bRight', TH.t('Право, px'), TH.t('Плюс: наружу (вправо), минус: внутрь')]]]
    ];

    // главная страница «Область помех»
    TH.settingsPage('tapokhub_fx', TH.t('Область помех'));

    TH.settingsTitle('tapokhub_fx', TH.t('На экране'));

    Lampa.SettingsApi.addParam({
        component: 'tapokhub_fx',
        param: { name: 'tapokhub_fx_edit', type: 'button' },
        field: { name: TH.t('Настроить прямо на экране'), description: TH.t('Открывает главный экран с рамкой области помех: углы, середины сторон и саму рамку можно двигать пальцем, мышью или стрелками пульта') },
        onChange: function () { TH.fxEdit.open(); }
    });

    TH.settingsTitle('tapokhub_fx', TH.t('Числами'));

    pages.forEach(function (pg) {
        Lampa.SettingsApi.addParam({
            component: 'tapokhub_fx',
            param: { name: 'tapokhub_open_' + pg[0].replace('tapokhub_', ''), type: 'button' },
            field: { name: pg[1], description: pg[2] },
            onChange: function () { TH.settingsOpen(pg[0], 'tapokhub_fx'); }
        });

        TH.settingsPage(pg[0], pg[1]);

        pg[3].forEach(function (f) {
            Lampa.SettingsApi.addParam({
                component: pg[0],
                param: { name: 'tapokhub_fx_' + f[0], type: 'input', values: '', default: String(TH.fx.defaults[f[0]]), placeholder: String(TH.fx.defaults[f[0]]) },
                field: { name: f[1], description: f[2] + TH.t('. По умолчанию ') + TH.fx.defaults[f[0]] }
            });
        });
    });

    TH.settingsTitle('tapokhub_fx', TH.t('Значения'));

    Lampa.SettingsApi.addParam({
        component: 'tapokhub_fx',
        param: { name: 'tapokhub_fx_show', type: 'button' },
        field: { name: TH.t('Показать текущие значения'), description: TH.t('Все отступы и только ненулевые углы, трапеция и выгиб одной строкой: их можно назвать разработчику') },
        onChange: function () { Lampa.Noty.show(TH.fx.describe()); }
    });

    Lampa.SettingsApi.addParam({
        component: 'tapokhub_fx',
        param: { name: 'tapokhub_fx_reset', type: 'button' },
        field: { name: TH.t('Сбросить'), description: TH.t('Ровный прямоугольник с отступами по умолчанию') },
        onChange: function () {
            Object.keys(TH.fx.defaults).forEach(function (k) { Lampa.Storage.set('tapokhub_fx_' + k, String(TH.fx.defaults[k])); });
            Lampa.Noty.show(TH.t('Область помех: значения по умолчанию'));
        }
    });
};
