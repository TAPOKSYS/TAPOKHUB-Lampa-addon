/* ---------- область помех: прямоугольник с настраиваемыми углами, трапецией и выгибом ----------
 *
 * По умолчанию область подогнана под стекло телевизора (значения владельца); «Сбросить» в настройках возвращает к ним. Все числа в пикселях, можно отрицательные:
 *  - отступы: left, right, top, bottom; скругление углов radius (0: острые углы);
 *  - углы: сдвиг каждого угла по X и по Y (tlx, tly левый верхний, trx, try правый верхний, blx, bly, brx, bry);
 *    +X вправо, +Y вниз;
 *  - трапеция: сужение верха, низа, левой и правой стороны (nTop, nBottom, nLeft, nRight): при плюсе сторона становится короче
 *    на это число с каждого конца, при минусе длиннее;
 *  - выгиб сторон (bTop, bBottom, bLeft, bRight): плюс выгибает сторону наружу, минус внутрь; середина стороны смещается на число.
 */
TH.fx = {
    defaults: { radius: 14, left: 8, right: -10, top: 6, bottom: 4,
        tlx: 0, tly: 3, trx: -40, try: 1, blx: 5, bly: -4, brx: -45, bry: -5,
        nTop: 8, nBottom: 0, nLeft: 0, nRight: 0,
        bTop: 8, bBottom: 7, bLeft: 8, bRight: 9 },
    limits: { min: -300, max: 300 },
    steps: 12,      // на сколько отрезков режется выгнутая сторона

    live: null,     // значения, которые меняются прямо сейчас в редакторе (пока не сохранены)

    // Значение параметра числом; неверный ввод — значение по умолчанию
    get: function (name) {
        if (TH.fx.live && name in TH.fx.live) return TH.fx.live[name];

        var raw = window.Lampa && Lampa.Storage ? Lampa.Storage.field('tapokhub_fx_' + name) : undefined;
        var n = parseFloat(String(raw === undefined || raw === null ? '' : raw).replace(',', '.'));

        if (isNaN(n)) return TH.fx.defaults[name];

        return Math.max(TH.fx.limits.min, Math.min(TH.fx.limits.max, n));
    },

    all: function () {
        var v = {};

        Object.keys(TH.fx.defaults).forEach(function (k) { v[k] = TH.fx.get(k); });

        return v;
    },

    // Сохранить значения, которые менялись в редакторе
    commit: function () {
        var live = TH.fx.live || {};

        Object.keys(live).forEach(function (k) { Lampa.Storage.set('tapokhub_fx_' + k, String(live[k])); });
        TH.fx.live = null;
    },

    clamp: function (n) {
        return Math.max(TH.fx.limits.min, Math.min(TH.fx.limits.max, Math.round(n)));
    },

    // Четыре угла: положение = [процент размера «стекла», пиксели] по каждой оси
    corners: function (v) {
        return {
            tl: { x: [0, v.left + v.tlx + v.nTop], y: [0, v.top + v.tly + v.nLeft] },
            tr: { x: [100, -v.right + v.trx - v.nTop], y: [0, v.top + v.try + v.nRight] },
            br: { x: [100, -v.right + v.brx - v.nBottom], y: [100, -v.bottom + v.bry - v.nRight] },
            bl: { x: [0, v.left + v.blx + v.nBottom], y: [100, -v.bottom + v.bly - v.nLeft] }
        };
    },

    // Контур: точки по часовой стрелке, от левого верхнего угла; каждая точка { x: [%, px], y: [%, px] }.
    // Выгнутая сторона режется на steps отрезков, прямая — без промежуточных точек.
    points: function (v) {
        var c = TH.fx.corners(v);
        var lerp = function (a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
        var pts = [];

        // сторона от a к b; bulge смещает середину по оси axis, sign — куда «наружу»
        var edge = function (a, b, bulge, axis, sign) {
            var n = bulge ? TH.fx.steps : 1;

            for (var i = 0; i < n; i++) {
                var t = i / n;
                var x = lerp(a.x, b.x, t);
                var y = lerp(a.y, b.y, t);
                var d = bulge ? sign * bulge * 4 * t * (1 - t) : 0;

                if (axis === 'y') y = [y[0], y[1] + d];
                else x = [x[0], x[1] + d];

                pts.push({ x: x, y: y, corner: i === 0 });
            }
        };

        edge(c.tl, c.tr, v.bTop, 'y', -1);        // верх: наружу — вверх
        edge(c.tr, c.br, v.bRight, 'x', 1);       // право: наружу — вправо
        edge(c.br, c.bl, v.bBottom, 'y', 1);      // низ: наружу — вниз
        edge(c.bl, c.tl, v.bLeft, 'x', -1);       // лево: наружу — влево

        return pts;
    },

    // Контур в пикселях для «стекла» шириной w и высотой h: четыре угла скруглены дугами радиуса v.radius (не больше половины стороны)
    outline: function (v, w, h) {
        var pts = TH.fx.points(v).map(function (p) { var q = TH.fx.resolve(p, w, h); q.corner = !!p.corner; return q; });
        var r = v.radius;
        var n = pts.length;
        var dist = function (a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); };
        var out = [];

        if (!(r > 0)) return pts;

        pts.forEach(function (p, i) {
            if (!p.corner) return out.push(p);

            var a = pts[(i - 1 + n) % n];
            var b = pts[(i + 1) % n];
            var la = dist(p, a);
            var lb = dist(p, b);
            var d = Math.min(r, la / 2, lb / 2);

            if (d < 0.5) return out.push(p);

            var pa = { x: p.x + (a.x - p.x) / la * d, y: p.y + (a.y - p.y) / la * d };
            var pb = { x: p.x + (b.x - p.x) / lb * d, y: p.y + (b.y - p.y) / lb * d };

            // квадратичная кривая от pa к pb с управляющей точкой в углу: круглая дуга без острия
            for (var k = 0; k <= 8; k++) {
                var t = k / 8;
                var u = 1 - t;

                out.push({ x: u * u * pa.x + 2 * u * t * p.x + t * t * pb.x, y: u * u * pa.y + 2 * u * t * p.y + t * t * pb.y });
            }
        });

        return out;
    },

    // Точка в пикселях для «стекла» шириной w и высотой h
    resolve: function (pt, w, h) {
        return { x: pt.x[0] * w / 100 + pt.x[1], y: pt.y[0] * h / 100 + pt.y[1] };
    },

    // Форма (значение clip-path) по параметрам v
    shape: function (v) {
        var round = function (n) { return Math.round(n * 100) / 100; };
        var coord = function (c) {
            var pct = round(c[0]);
            var px = round(c[1]);

            if (!px) return pct + '%';
            if (!pct) return px + 'px';

            return 'calc(' + pct + '% ' + (px < 0 ? '- ' + Math.abs(px) : '+ ' + px) + 'px)';
        };

        return 'polygon(' + TH.fx.points(v).map(function (p) { return coord(p.x) + ' ' + coord(p.y); }).join(',') + ')';
    },

    // Положить форму на элемент области помех (он занимает всё «стекло», форму задаёт clip-path).
    // Без скругления форма в процентах и пикселях (сама подстраивается под размер), со скруглением дуги считаются в пикселях
    // по измеренному размеру стекла (при изменении размера окна форма пересчитывается).
    apply: function (node) {
        var v = TH.fx.all();
        var shape;

        if (v.radius > 0) {
            var r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
            var w = r && r.width ? r.width : TH.fxEdit.SIZE.w;
            var h = r && r.height ? r.height : TH.fxEdit.SIZE.h;

            shape = 'polygon(' + TH.fx.outline(v, w, h).map(function (p) { return Math.round(p.x * 100) / 100 + 'px ' + Math.round(p.y * 100) / 100 + 'px'; }).join(',') + ')';
        }
        else shape = TH.fx.shape(v);

        node.style.clipPath = shape;
        node.style.webkitClipPath = shape;
    },

    // Одной строкой: отступы и только то, что отличается от нуля
    describe: function () {
        var v = TH.fx.all();
        var groups = [[TH.t('отступы'), ['left', 'right', 'top', 'bottom'], [TH.t('слева'), TH.t('справа'), TH.t('сверху'), TH.t('снизу')]],
            [TH.t('углы'), ['tlx', 'tly', 'trx', 'try', 'blx', 'bly', 'brx', 'bry'], [TH.t('лв.x'), TH.t('лв.y'), TH.t('пв.x'), TH.t('пв.y'), TH.t('лн.x'), TH.t('лн.y'), TH.t('пн.x'), TH.t('пн.y')]],
            [TH.t('трапеция'), ['nTop', 'nBottom', 'nLeft', 'nRight'], [TH.t('верх'), TH.t('низ'), TH.t('лево'), TH.t('право')]],
            [TH.t('выгиб'), ['bTop', 'bBottom', 'bLeft', 'bRight'], [TH.t('верх'), TH.t('низ'), TH.t('лево'), TH.t('право')]]];
        var out = [];

        groups.forEach(function (g) {
            var items = [];

            g[1].forEach(function (k, i) { if (g[0] === TH.t('отступы') || v[k] !== 0) items.push(g[2][i] + ' ' + v[k]); });

            if (g[0] === TH.t('отступы')) items.push(TH.t('скругление ') + v.radius);

            if (items.length) out.push(g[0] + ': ' + items.join(', '));
        });

        return TH.t('Область помех: ') + out.join('; ');
    }
};
