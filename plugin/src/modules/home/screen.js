/* ---------- компонент ---------- */

function el(tag, cls, html) {
    var node = document.createElement(tag);

    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;

    return node;
}

// Метка на body, пока открыт главный экран хаба (по ней стили выше не дают меню сдвигать сцену)
function setHomeClass(on) {
    var body = typeof document !== 'undefined' && document.body;

    if (body && body.classList) body.classList[on ? 'add' : 'remove']('tapokhub-home-on');
}

function HomeScreen(object) {
    var editing = !!(object && object.tapokhub_fxedit);   // режим правки области помех на экране
    var editor = null;
    var TAP_MOVE = 14;      // допуск смещения пальца при тапе, px (как в старом плагине)
    var SWIPE_MIN = 28;     // с этого смещения по горизонтали жест считается свайпом
    var TAP_MAX_TIME = 700; // мс: дольше — не тап

    var root = el('div', 'tapokhub-home');
    var stage = el('div', 'tapokhub-home__stage');
    var screen = el('div', 'tapokhub-home__screen');
    var dots = el('div', 'tapokhub-home__dots');
    var icon = el('div', 'tapokhub-home__icon');
    var label = el('div', 'tapokhub-home__label');
    var hint = el('div', 'tapokhub-home__hint');
    var stats = el('div', 'tapokhub-home__stats');
    var leds = el('div', 'tapokhub-home__leds');
    var vcrdisp = el('div', 'tapokhub-home__vcrdisp');
    var tvled = el('div', 'tapokhub-home__tvled');
    var fx = el('div', 'tapokhub-home__fx');
    var noise = el('div', 'tapokhub-home__noise');
    var clock = el('div', 'tapokhub-home__clock');
    var roll = el('div', 'tapokhub-home__roll');
    var sections = [];
    var index = 0;
    var touch = null;
    var lastTouch = 0;
    var listeners = [];
    var resizeBound = false;
    var owner = {};         // владелец общего слоя фона (TH.backdrop)

    screen.appendChild(dots);
    screen.appendChild(icon);
    screen.appendChild(label);
    screen.appendChild(hint);
    screen.appendChild(stats);      // после подсказки: порядок дочерних элементов «стекла» не менять
    screen.appendChild(leds);
    fx.appendChild(noise);
    fx.appendChild(roll);
    screen.appendChild(fx);
    stage.appendChild(screen);
    stage.appendChild(vcrdisp);
    stage.appendChild(tvled);
    stage.appendChild(clock);
    root.appendChild(stage);

    function on(node, type, fn, opts) {
        node.addEventListener(type, fn, opts);
        listeners.push([node, type, fn, opts]);
    }

    function draw() {
        var s = sections[index];

        icon.innerHTML = s ? (s.icon || '') : '';
        label.textContent = s ? s.title : '';
        // стрелки по бокам рисует CSS (класс is-nav): символы ◀ ▶ есть не в каждом шрифте и превращаются в квадратики
        hint.textContent = sections.length > 1 ? TH.t('ВЫБЕРИТЕ РАЗДЕЛ') : TH.t('НАЖМИТЕ  OK');
        hint.className = 'tapokhub-home__hint' + (sections.length > 1 ? ' is-nav' : '');

        // индикатор положения показываем, только если есть из чего выбирать
        var marks = '';

        if (sections.length > 1) {
            for (var i = 0; i < sections.length; i++) marks += '<b class="' + (i === index ? 'is-active' : '') + '">●</b>';
        }

        dots.innerHTML = marks;

    }

    // Сводка библиотеки под названием раздела: фильмы, сериалы, коллекции, просмотрено (по отметке Lampa)
    var statsToken = 0;

    function drawStats() {
        var token = ++statsToken;

        // «Просмотрено» в сводке должно быть свежим: сначала отмечаем фильмы, просмотренные на 70%+
        try { if (TH.recs) TH.recs.autoMark(); } catch (e) { TH.log('automark failed', e && e.message); }

        TH.lib.loadStats(function (st) {
            if (token !== statsToken || !st) return;

            var names = [TH.t('ФИЛЬМЫ'), TH.t('СЕРИАЛЫ'), TH.t('КОЛЛЕКЦИИ'), TH.t('ПРОСМОТРЕНО')];
            var target = [st.movies, st.tv, st.collections, st.viewed];
            var show = function (values) {
                stats.innerHTML = values.map(function (n, i) { return '<div><b>' + n + '</b><span>' + names[i] + '</span></div>'; }).join('');
            };

            if (!TH.anim.counters()) return show(target);

            // Счётчики набираются с нуля до значений (Настройки -> TapokHub -> «Счётчики набираются с нуля»)
            var t0 = Date.now();
            var ms = Math.max(1, TH.anim.countMs);
            var next = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };

            (function frame() {
                if (token !== statsToken) return;             // ушли с экрана или пришли новые данные

                var p = Math.min(1, (Date.now() - t0) / ms);
                var eased = 1 - Math.pow(1 - p, 3);          // сначала быстро, к концу замедляется

                show(target.map(function (n) { return Math.round(n * eased); }));

                if (p < 1) next(frame);
            })();
        });
    }

    // Дисплей видеомагнитофона: обычно текущее время (перерисовка в начале минуты); при включённом «воспроизведении»
    // идёт счётчик минут и секунд от нуля с момента входа на экран, как у видеомагнитофонов 90-х
    var clockTimer = null;
    var clockShown = '';
    var playStart = 0;

    function drawClock() {
        var now = new Date();
        var playing = TH.anim.vcr();
        var first;
        var second;
        var wait;

        if (playing) {
            var elapsed = Math.max(0, Math.floor((now.getTime() - playStart) / 1000));

            first = Math.floor(elapsed / 60) % 100;
            second = elapsed % 60;
            wait = 1000 - ((now.getTime() - playStart) % 1000) + 5;   // ровно по секундам от начала воспроизведения, а не от часов
        }
        else {
            first = now.getHours();
            second = now.getMinutes();
            wait = (61 - now.getSeconds()) * 1000 - now.getMilliseconds();
        }

        var stamp = (playing ? 'p' + now.getHours() + ':' + now.getMinutes() + '/' : 'c') + first + ':' + second;

        if (stamp !== clockShown) {
            clockShown = stamp;

            if (playing) vcrdisp.innerHTML = TH.clock.playSvg(first, second, now.getHours(), now.getMinutes());
            else clock.innerHTML = TH.clock.svg(first, second);
        }

        clearTimeout(clockTimer);
        clockTimer = setTimeout(drawClock, wait);
    }

    function stopClock() {
        clearTimeout(clockTimer);
        clockTimer = null;
    }

    // Огоньки соединений (сервер, парсер, TorrServer): при входе на экран и раз в минуту, пока он открыт
    var LED_NAMES = [['server', TH.t('СЕРВЕР')], ['parser', TH.t('ПАРСЕР')], ['torrserver', TH.t('ТОРРС')]];
    var ledState = { server: 'wait', parser: 'wait', torrserver: 'wait' };
    var ledTimer = null;
    var ledToken = 0;

    // Светодиод на корпусе телевизора: общее состояние. Красный: наш сервер не отвечает; жёлтый: идёт проверка или парсер
    // / TorrServer настроены, но молчат; зелёный: всё, что настроено, работает; тусклый: нет входа
    function tvLed() {
        var st = ledState;

        if (st.server === 'bad') return 'is-bad';
        if (st.server === 'wait' || st.parser === 'wait' || st.torrserver === 'wait' || st.parser === 'bad' || st.torrserver === 'bad') return 'is-warn';
        if (st.server === 'off') return '';

        return 'is-ok';
    }

    function drawLeds() {
        tvled.className = 'tapokhub-home__tvled ' + tvLed();
        leds.innerHTML = LED_NAMES.map(function (n) {
            return '<div class="is-' + ledState[n[0]] + '"><i></i><b>' + n[1] + '</b></div>';
        }).join('');
    }

    function checkLeds() {
        var token = ++ledToken;

        clearTimeout(ledTimer);
        ledState = { server: 'wait', parser: 'wait', torrserver: 'wait' };
        drawLeds();

        TH.status.check(function (name, state) {
            if (token !== ledToken) return;      // ушли с экрана или запустили новую проверку

            ledState[name] = state;
            drawLeds();
        }, function () {
            if (token === ledToken) ledTimer = setTimeout(checkLeds, 60000);
        });
    }

    function stopLeds() {
        ledToken++;
        clearTimeout(ledTimer);
        ledTimer = null;
    }

    function setIndex(i) {
        if (!sections.length) return;

        index = Math.max(0, Math.min(sections.length - 1, i));
        draw();
    }

    function open() {
        var s = sections[index];

        if (s) s.open();
    }

    // Касания: свайп по горизонтали листает разделы, короткий тап по «стеклу» открывает.
    // Своя проверка допуска: браузер отменяет click, если палец дрогнул, а в Lampa тап — это click.
    on(root, 'touchstart', function (e) {
        if (editing) return;      // в режиме правки области помех касания принадлежат ручкам, разделы не листаем

        var p = e.touches && e.touches[0];

        touch = p && e.touches.length === 1 ? { x: p.clientX, y: p.clientY, at: Date.now(), target: e.target } : null;
    }, { passive: true });

    on(root, 'touchend', function (e) {
        if (editing) return;

        var t = touch;
        var p = e.changedTouches && e.changedTouches[0];

        touch = null;

        if (!t || !p) return;

        lastTouch = Date.now();

        var dx = p.clientX - t.x;
        var dy = p.clientY - t.y;
        var handled = false;

        if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) {
            setIndex(index + (dx < 0 ? 1 : -1));
            handled = true;
        }
        else if (Math.abs(dx) <= TAP_MOVE && Math.abs(dy) <= TAP_MOVE && Date.now() - t.at <= TAP_MAX_TIME && screen.contains(t.target)) {
            open();
            handled = true;
        }

        // Браузер после касания сам пришлёт click. К этому моменту на месте пальца уже новый экран,
        // и «призрачный» click открыл бы там карточку. Обработанное касание click не порождает.
        if (handled && e.cancelable && e.preventDefault) e.preventDefault();
    }, { passive: false });

    // Мышь: click. Если только что был тач, click от него игнорируем (тап уже обработан).
    on(root, 'click', function (e) {
        if (editing) return;
        if (Date.now() - lastTouch < 600) return;
        if (screen.contains(e.target)) open();
    });

    this.create = function () {
        sections = TH.sections.list();
        draw();

        return this.render();
    };

    this.start = function () {
        // Контейнер экрана (.activity__body) своей высоты не имеет: его дети позиционируются
        // абсолютно, и 100% от нуля дали бы пустоту. Растягиваем на всю область активности
        // (она уже учитывает шапку Lampa).
        if (root.parentNode && root.parentNode.style) root.parentNode.style.height = '100%';

        // Кадр фильма от прошлого экрана не должен просвечивать под шапкой и нижней панелью
        TH.background.reset();
        root.className = 'tapokhub-home' + (TH.anim.crt() || editing ? ' tapokhub-crt' : '') + (TH.anim.vcr() ? ' tapokhub-vcr' : '');
        TH.fx.apply(fx);        // форма области помех из настроек
        if (editing && !editor) startEditor();
        setHomeClass(true);
        checkLeds();
        if (TH.play) TH.play.sync();   // выбранные торренты с других устройств (не чаще раза в минуту)
        if (TH.sync) TH.sync.pull();   // настройки плагина с сервера (не чаще раза в минуту)
        playStart = Date.now();
        clockShown = '';
        drawClock();          // пока экран открыт, время на дисплее видеомагнитофона идёт
        drawStats();          // при каждом возврате на главный: отметки Lampa за это время меняются
        TH.backdrop.show(owner, 'scene', sceneRect());   // картинка продолжается под шапкой и боковым меню
        placeLater();

        // Возврат с дочернего экрана: разделы могли добавиться, положение сохраняем
        sections = TH.sections.list();
        setIndex(index);

        Lampa.Controller.add('content', {
            toggle: function () {
                Lampa.Controller.clear(); // выбирать нечего: разделы листаем сами
            },
            left: function () {
                if (editor) return editor.nudge(-1, 0);
                if (index > 0) setIndex(index - 1);
                else Lampa.Controller.toggle('menu'); // у левого края уходим в боковое меню
            },
            right: function () { if (editor) editor.nudge(1, 0); else setIndex(index + 1); },
            up: function () { if (editor) editor.nudge(0, -1); else Lampa.Controller.toggle('head'); },
            down: function () { if (editor) editor.nudge(0, 1); },
            enter: function () { if (editor) editor.next(); else open(); },
            back: function () { if (editor) exitEditor(); else Lampa.Activity.backward(); }
        });

        Lampa.Controller.toggle('content');
    };

    // Прямоугольник сцены в окне: по нему картинка общего слоя ложится точно под сцену (полоса меню на ТВ, шапка)
    function sceneRect() {
        var r = stage.getBoundingClientRect ? stage.getBoundingClientRect() : null;

        return r && r.width ? { left: Math.round(r.left * 100) / 100, top: Math.round(r.top * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 } : null;
    }

    function place() {
        TH.backdrop.place(owner, sceneRect());
        if (TH.fx.get('radius') > 0) TH.fx.apply(fx);   // дуги скруглённых углов считаются в пикселях: пересчитать под новый размер
    }

    // раскладка ещё не завершена в момент start, а окно может меняться
    function placeLater() {
        if (typeof setTimeout === 'function') { setTimeout(place, 0); setTimeout(place, 400); }
        if (typeof window !== 'undefined' && window.addEventListener && !resizeBound) {
            resizeBound = true;
            window.addEventListener('resize', place);
            listeners.push([window, 'resize', place, false]);
        }
    }

    function startEditor() {
        editor = TH.fxEdit.create(stage, fx, exitEditor);
    }

    // Сохранить, закрыть редактор и вернуться к странице настроек, откуда пришли
    function exitEditor() {
        if (editor) editor.destroy();

        editor = null;
        editing = false;

        Lampa.Activity.backward();

        setTimeout(function () {
            try {
                Lampa.Controller.toggle('settings');
                Lampa.Settings.create('tapokhub_fx', { onBack: function () { Lampa.Settings.create('tapokhub_anim'); } });
            } catch (e) { /* настройки не открылись: остаёмся на предыдущем экране */ }
        }, 400);
    }

    this.pause = function () { TH.backdrop.hide(owner); setHomeClass(false); stopClock(); stopLeds(); };
    this.stop = function () { TH.backdrop.hide(owner); setHomeClass(false); stopClock(); stopLeds(); };

    this.render = function (js) {
        return js ? root : $(root);
    };

    this.destroy = function () {
        listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
        listeners = [];
        statsToken++;         // ответ сервера после закрытия экрана не рисуем
        if (editor) { editor.destroy(); editor = null; }
        stopClock();
        stopLeds();

        if (root.parentNode) root.parentNode.removeChild(root);

        TH.backdrop.hide(owner);
        setHomeClass(false);
        TH.background.reset();   // выходим в меню Lampa: фон по умолчанию, а не кадр последнего фильма
    };

    // для тестов и отладки
    this.state = function () { return { index: index, count: sections.length }; };
    this.setIndex = setIndex;
}
