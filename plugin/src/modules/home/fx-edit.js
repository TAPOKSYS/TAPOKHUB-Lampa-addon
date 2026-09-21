/* ---------- настройка области помех прямо на экране ----------
 *
 * Главный экран в режиме правки: поверх «стекла» рамка области помех с ручками. Круглые ручки в углах двигают углы, квадратные на
 * серединах сторон выгибают стороны (наружу или внутрь), синяя посередине двигает всю рамку. Тянуть можно пальцем и мышью;
 * с пульта: OK выбирает следующую ручку, стрелки двигают выбранную на 1 px, «Назад» сохраняет и выходит. Значения пишутся в те же
 * настройки, что и на страницах Настройки -> TapokHub -> Анимация -> Область помех.
 */
TH.fxEdit = {
    HANDLES: ['tl', 'tr', 'br', 'bl', 'top', 'right', 'bottom', 'left', 'pan'],
    SIZE: { w: 500, h: 280 },   // размер «стекла» по умолчанию, если измерить нельзя

    // Открыть главный экран в режиме правки (из настроек)
    open: function () {
        try { $('body').removeClass('settings--open'); } catch (e) { /* без настроек на экране */ }

        Lampa.Controller.toggle('content');
        Lampa.Activity.push({ url: '', title: 'TapokHub', component: TH.components.home, page: 1, tapokhub_fxedit: true });
    },

    // Как двигается параметр при смещении ручки name на (dx, dy) от значений start
    move: function (name, dx, dy, start, live) {
        var set = function (k, val) { live[k] = TH.fx.clamp(val); };
        var corner = { tl: ['tlx', 'tly'], tr: ['trx', 'try'], bl: ['blx', 'bly'], br: ['brx', 'bry'] };

        if (corner[name]) {
            set(corner[name][0], start[corner[name][0]] + dx);
            set(corner[name][1], start[corner[name][1]] + dy);
        }
        else if (name === 'top') set('bTop', start.bTop - dy);
        else if (name === 'bottom') set('bBottom', start.bBottom + dy);
        else if (name === 'left') set('bLeft', start.bLeft - dx);
        else if (name === 'right') set('bRight', start.bRight + dx);
        else if (name === 'pan') {
            set('left', start.left + dx);
            set('right', start.right - dx);
            set('top', start.top + dy);
            set('bottom', start.bottom - dy);
        }
    },

    // Положения ручек в пикселях «стекла»: углы, середины сторон (с учётом выгиба) и центр
    handlePoints: function (v, w, h) {
        var c = TH.fx.corners(v);
        var r = function (k) { return TH.fx.resolve(c[k], w, h); };
        var tl = r('tl');
        var tr = r('tr');
        var br = r('br');
        var bl = r('bl');
        var mid = function (a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
        var t = mid(tl, tr);
        var ri = mid(tr, br);
        var bo = mid(br, bl);
        var le = mid(bl, tl);

        return {
            tl: tl, tr: tr, br: br, bl: bl,
            top: { x: t.x, y: t.y - v.bTop }, right: { x: ri.x + v.bRight, y: ri.y },
            bottom: { x: bo.x, y: bo.y + v.bBottom }, left: { x: le.x - v.bLeft, y: le.y },
            pan: { x: (tl.x + tr.x + br.x + bl.x) / 4, y: (tl.y + tr.y + br.y + bl.y) / 4 }
        };
    },

    // Создать редактор на сцене stage; fxEl — элемент области помех, done() вызывается по кнопке «Готово»
    create: function (stage, fxEl, done) {
        var box = el('div', 'tapokhub-home__fxedit');
        var ns = 'http://www.w3.org/2000/svg';
        var outline = el('div', 'tapokhub-home__fxedit__outline');
        var panel = el('div', 'tapokhub-home__fxedit__panel');
        var readout = el('div', 'tapokhub-home__fxedit__readout');
        var buttons = el('div', 'tapokhub-home__fxedit__buttons');
        var handles = {};
        var selected = 0;
        var drag = null;
        var listeners = [];

        var size = function () {
            var r = box.getBoundingClientRect ? box.getBoundingClientRect() : null;

            return r && r.width ? { w: r.width, h: r.height } : TH.fxEdit.SIZE;
        };

        function draw() {
            var sz = size();
            var v = TH.fx.all();
            var pts = TH.fx.outline(v, sz.w, sz.h).map(function (q) { return Math.round(q.x * 10) / 10 + ',' + Math.round(q.y * 10) / 10; }).join(' ');
            var hp = TH.fxEdit.handlePoints(v, sz.w, sz.h);

            outline.innerHTML = '<svg xmlns="' + ns + '" width="' + sz.w + '" height="' + sz.h + '" aria-hidden="true"><polygon points="' + pts + '"/></svg>';

            TH.fxEdit.HANDLES.forEach(function (name, i) {
                handles[name].style.left = Math.round(hp[name].x) + 'px';
                handles[name].style.top = Math.round(hp[name].y) + 'px';
                handles[name].className = 'tapokhub-home__fxedit__h is-' + name + (i === selected ? ' is-sel' : '');
            });

            readout.textContent = TH.fx.describe();
        }

        function change(name, dx, dy, start) {
            TH.fx.live = TH.fx.live || {};
            TH.fxEdit.move(name, dx, dy, start, TH.fx.live);
            TH.fx.apply(fxEl);
            draw();
        }

        function listen(node, type, fn) {
            node.addEventListener(type, fn);
            listeners.push([node, type, fn]);
        }

        function stopDrag() {
            if (!drag) return;

            drag = null;
            TH.fx.commit();
            draw();
        }

        TH.fxEdit.HANDLES.forEach(function (name, i) {
            var h = el('div', 'tapokhub-home__fxedit__h is-' + name);

            handles[name] = h;
            box.appendChild(h);

            listen(h, 'pointerdown', function (e) {
                if (e.preventDefault) e.preventDefault();
                if (e.stopPropagation) e.stopPropagation();

                selected = i;
                drag = { name: name, x: e.clientX, y: e.clientY, start: TH.fx.all() };
                draw();
            });
        });

        listen(window, 'pointermove', function (e) {
            if (drag) change(drag.name, e.clientX - drag.x, e.clientY - drag.y, drag.start);
        });
        listen(window, 'pointerup', stopDrag);
        listen(window, 'pointercancel', stopDrag);

        var mk = function (text, fn) {
            var b = el('div', 'tapokhub-home__fxedit__btn');

            b.textContent = text;

            listen(b, 'pointerdown', function (e) {
                if (e.preventDefault) e.preventDefault();
                if (e.stopPropagation) e.stopPropagation();

                fn();
            });
            buttons.appendChild(b);
        };

        var radius = function (delta) {
            TH.fx.live = TH.fx.live || {};
            TH.fx.live.radius = Math.max(0, TH.fx.clamp(TH.fx.get('radius') + delta));
            TH.fx.apply(fxEl);
            TH.fx.commit();
            draw();
        };

        mk(TH.t('Скругл. −'), function () { radius(-2); });
        mk(TH.t('Скругл. +'), function () { radius(2); });
        mk(TH.t('Готово'), function () { TH.fx.commit(); done(); });
        mk(TH.t('Сбросить'), function () {
            TH.fx.live = {};
            Object.keys(TH.fx.defaults).forEach(function (k) { TH.fx.live[k] = TH.fx.defaults[k]; });
            TH.fx.apply(fxEl);
            TH.fx.commit();
            draw();
        });

        box.appendChild(outline);
        panel.appendChild(readout);
        panel.appendChild(buttons);
        box.appendChild(panel);
        stage.appendChild(box);
        draw();

        return {
            node: box,
            select: function (i) { selected = (i + TH.fxEdit.HANDLES.length) % TH.fxEdit.HANDLES.length; draw(); },
            next: function () { this.select(selected + 1); },
            selected: function () { return TH.fxEdit.HANDLES[selected]; },
            // Сдвинуть выбранную ручку на (dx, dy) px от текущих значений (стрелки пульта)
            nudge: function (dx, dy) { change(TH.fxEdit.HANDLES[selected], dx, dy, TH.fx.all()); TH.fx.commit(); },
            redraw: draw,
            destroy: function () {
                listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
                listeners = [];
                TH.fx.commit();

                if (box.parentNode) box.parentNode.removeChild(box);
            }
        };
    }
};
