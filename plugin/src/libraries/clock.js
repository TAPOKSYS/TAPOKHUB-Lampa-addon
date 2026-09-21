TH.clock = (function () {
    // какие сегменты горят у цифры: a верх, b правый верх, c правый низ, d низ, e левый низ, f левый верх, g середина
    var DIGITS = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
    function segments(x, y, ch, w, h) {
        var W = w || 5;
        var H = h || 11;
        var mid = y + H / 2;
        var t = 0.8;
        var line = {
            a: [x + t, y, x + W - t, y], b: [x + W, y + t, x + W, mid - t], c: [x + W, mid + t, x + W, y + H - t],
            d: [x + t, y + H, x + W - t, y + H], e: [x, mid + t, x, y + H - t], f: [x, y + t, x, mid - t], g: [x + t, mid, x + W - t, mid]
        };
        var on = DIGITS[ch];

        return 'abcdefg'.split('').map(function (k) {
            var l = line[k];

            return '<line class="' + (on.indexOf(k) > -1 ? 'on' : 'off') + '" x1="' + l[0] + '" y1="' + l[1] + '" x2="' + l[2] + '" y2="' + l[3] + '"/>';
        }).join('');
    }

    // Разметка часов для h:m. Наклон, свечение и цвета задаёт CSS (.tapokhub-home__clock)
    function svg(h, m) {
        var d = [Math.floor(h / 10), h % 10, Math.floor(m / 10), m % 10];
        var xs = [2, 9.2, 21.4, 28.6];   // между цифрами просвет 2.2, иначе на маленьком дисплее сегменты соседних цифр сливаются
        var out = '<svg viewBox="0 0 36 17" preserveAspectRatio="none" aria-hidden="true"><g class="digits" transform="translate(1.9,3) skewX(-9)">';

        d.forEach(function (n, i) { out += '<g data-d="' + n + '">' + segments(xs[i], 0, n) + '</g>'; });

        return out + '<g class="colon"><circle cx="17.8" cy="3.4" r=".85"/><circle cx="17.8" cy="7.6" r=".85"/></g></g></svg>';
    }

    // Точечные буквы слова PLAY (3 x 5): мелкие, как надписи на дисплее видеомагнитофона
    var GLYPHS = {
        P: ['###', '#.#', '###', '#..', '#..'],
        L: ['#..', '#..', '#..', '#..', '###'],
        A: ['.#.', '#.#', '###', '#.#', '#.#'],
        Y: ['#.#', '#.#', '.#.', '.#.', '.#.']
    };

    // Цифры блока (m1 m2 : s1 s2) в строке y: возвращает разметку; attr — data-d (счётчик) или data-c (часы)
    function block(a, b, y, attr, x0) {
        var d = [Math.floor(a / 10), a % 10, Math.floor(b / 10), b % 10];
        var xs = [x0, x0 + 4.6, x0 + 12.4, x0 + 17];
        var out = '<g transform="translate(1,' + y + ') skewX(-9)">';

        d.forEach(function (n, i) { out += '<g ' + attr + '="' + n + '">' + segments(xs[i], 0, n, 3.2, 6) + '</g>'; });

        return out + '<g class="colon"><circle cx="' + (x0 + 10.2) + '" cy="1.9" r=".55"/><circle cx="' + (x0 + 10.2) + '" cy="4.1" r=".55"/></g></g>';
    }

    // Дисплей воспроизведения (рисунок 62 x 22), две строки:
    //  верхняя: значок и слово PLAY, справа текущее время (часы);
    //  нижняя: значок кассеты и счётчик времени воспроизведения (минуты:секунды).
    function playSvg(m, sec, h, min) {
        var out = '<svg viewBox="0 0 62 22" preserveAspectRatio="none" aria-hidden="true">';
        var x = 8;

        out += '<polygon class="lit" points="2,3.6 5.6,6.1 2,8.6"/>';

        'PLAY'.split('').forEach(function (ch) {
            GLYPHS[ch].forEach(function (row, r) {
                row.split('').forEach(function (c, i) {
                    if (c === '#') out += '<rect class="lit" x="' + (x + i) + '" y="' + (3.6 + r) + '" width=".88" height=".88"/>';
                });
            });

            x += 4;
        });

        // значок кассеты рядом со счётчиком
        out += '<rect class="tape" x="2" y="13" width="9" height="5.4" rx=".7" fill="none" stroke-width=".7"/>' +
            '<circle class="tape" cx="4.6" cy="15.7" r=".95" fill="none" stroke-width=".5"/><circle class="tape" cx="8.4" cy="15.7" r=".95" fill="none" stroke-width=".5"/>';

        out += block(h, min, 3.5, 'data-c', 33);      // часы
        out += block(m, sec, 12.5, 'data-d', 33);     // счётчик

        return out + '</svg>';
    }

    return { svg: svg, playSvg: playSvg, DIGITS: DIGITS };
})();
