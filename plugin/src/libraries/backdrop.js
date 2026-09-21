/* ---------- свой фон экрана ----------
 *
 * Слой на всё окно (включая место под боковым меню и шапкой) между фоном Lampa (.background) и содержимым (.wrap).
 * Один слой на всё приложение; экран, который его включил, обязан выключить его на pause/destroy: иначе он закрыл бы
 * кадры фильма на нативных экранах. hide(who) от чужого владельца игнорируется (новый экран мог уже занять слой).
 *   mode 'dark' - сплошной цвет сцены телевизора; 'blur' - размытая картинка хаба (plugin/assets/menu-background-blur.jpg);
 *   'scene' - сама картинка хаба под сценой главного экрана (см. show/place).
 */
TH.backdrop = (function () {
    var layer = null;
    var owner = null;

    function ensure() {
        if (layer) return layer;
        if (typeof document === 'undefined' || !document.body || !document.createElement) return null;

        layer = document.createElement('div');
        layer.className = 'tapokhub-backdrop';
        layer.style.display = 'none';
        document.body.appendChild(layer);

        return layer;
    }

    function paint(l, mode, geom) {
        var url = mode === 'blur' ? TH.assetUrl('menu-background-blur.jpg') : mode === 'scene' ? TH.assetUrl('menu-background.jpg') : '';

        l.className = 'tapokhub-backdrop tapokhub-backdrop--' + mode;
        l.style.backgroundImage = url ? 'url("' + url + '")' : '';

        // 'scene': та же картинка и в тех же координатах, что у сцены главного экрана (geom = её прямоугольник в окне),
        // чтобы под шапкой, боковым меню и его полосой на ТВ она продолжалась без шва
        l.style.backgroundPosition = mode === 'scene' && geom ? geom.left + 'px ' + geom.top + 'px' : '';
        l.style.backgroundSize = mode === 'scene' && geom ? geom.width + 'px ' + geom.height + 'px' : '';
    }

    return {
        show: function (who, mode, geom) {
            var l = ensure();

            owner = who;
            if (!l) return;

            paint(l, mode, geom);
            l.style.display = '';
        },
        // сдвинуть картинку, не меняя владельца: окно или полоса меню изменились
        place: function (who, geom) {
            if (owner === who && layer) paint(layer, 'scene', geom);
        },
        hide: function (who) {
            if (owner !== who) return;

            owner = null;
            if (layer) layer.style.display = 'none';
        },
        owner: function () { return owner; },
        element: function () { return layer; }    // для тестов и отладки
    };
})();
