/* ---------- стили ---------- */

// Кадр фона 1672x941, «стекло» телевизора внутри него: x=520 y=184 w=660 h=365 (как в старом плагине).
// Все размеры в долях ширины сцены (--u = 1% ширины), поэтому пересчёт скриптом не нужен.
// Ширина сцены: как «cover» на широком экране, но не шире 230% ширины окна: на вертикальном
// телефоне «cover» вырезал бы из телевизора кусок, а так «стекло» видно целиком; верх и низ
// сцены плавно уходят в цвет фона, чтобы у картинки не было жёстких краёв.
TH.homeCss = function () {
    var bg = TH.assetUrl('menu-background.jpg');

    Lampa.Template.add('tapokhub_home_css', '<style>' +
        '.tapokhub-home{position:fixed;left:0;top:0;right:0;bottom:0;overflow:hidden;background:#04040a;' +
            '--w:min(max(100vw,177.68vh),230vw);--u:calc(var(--w)/100)}' +
        // Боковое меню Lampa сдвигает весь контент (wrap__content) на 15em. На нашем экране не сдвигаем: меню ложится
        // поверх картинки, и под ним та же сцена, а не пустая полоса другого цвета. Пока меню открыто, сцена притемнена.
        'body.tapokhub-home-on.menu--open:not(.light--version) .wrap__content,' +
        'body.tapokhub-home-on.menu--always.menu--open:not(.light--version) .wrap__content{transform:none}' +
        'body.tapokhub-home-on.menu--open .tapokhub-home{opacity:.6}' +
        '.tapokhub-home__stage{position:absolute;left:50%;top:50%;width:var(--w);height:calc(var(--w)*0.5628);' +
            'transform:translate(-50%,-50%);background:#04040a' + (bg ? ' url("' + bg + '") center/100% 100% no-repeat' : '') + '}' +
        '.tapokhub-home__clock{position:absolute;left:53.53%;top:69.18%;width:2.153%;height:1.807%;z-index:1;pointer-events:none;background:#050306;overflow:hidden}' +
        '.tapokhub-home__clock svg{display:block;width:100%;height:100%}' +
        '.tapokhub-home__clock line{stroke-width:1;stroke-linecap:round}' +
        '.tapokhub-home__clock line.off{stroke:#3a0a10;opacity:.3}' +
        '.tapokhub-home__clock line.on{stroke:#ff3b40}' +
        '.tapokhub-home__clock .colon circle{fill:#ff3b40;animation:tapokhub-colon 1s steps(1,end) infinite}' +
        '@keyframes tapokhub-colon{0%{opacity:1}50%{opacity:.12}}' +
        // Светодиод на корпусе телевизора (под динамиком справа): зелёный, когда всё работает, жёлтый при проверке или сбое парсера или
        // TorrServer, красный при недоступном сервере, тусклый красный без входа. Место в долях кадра 1672x941: центр (1200, 552).
        '.tapokhub-home__tvled{position:absolute;left:71.5%;top:58.4%;width:.36%;height:.64%;z-index:1;pointer-events:none;border-radius:50%;background:#3a1010}' +
        '.tapokhub-home__tvled.is-ok{background:#5dff8f;box-shadow:0 0 .55em .12em rgba(93,255,143,.75)}' +
        '.tapokhub-home__tvled.is-warn{background:#ffd24a;box-shadow:0 0 .55em .12em rgba(255,210,74,.75)}' +
        '.tapokhub-home__tvled.is-bad{background:#ff4b4b;box-shadow:0 0 .55em .12em rgba(255,75,75,.75)}' +
        // Дисплей видеомагнитофона в режиме воспроизведения (Настройки -> TapokHub): значок и слово PLAY, счётчик времени, как у
        // видеомагнитофонов 90-х. Место в долях кадра 1672x941: панель дисплея x 882-944, y 647-669.
        '.tapokhub-home__vcrdisp{display:none;position:absolute;left:52.75%;top:68.76%;width:3.708%;height:2.338%;z-index:1;pointer-events:none;background:#050306;overflow:hidden}' +
        '.tapokhub-home__vcrdisp svg{display:block;width:100%;height:100%}' +
        '.tapokhub-home__vcrdisp .lit{fill:#ff4a2a}' +
        '.tapokhub-home__vcrdisp line.on{stroke:#ff4a2a}' +
        '.tapokhub-home__vcrdisp line{stroke-width:.9;stroke-linecap:round}' +
        '.tapokhub-home__vcrdisp line.off{stroke:#3a0a10;opacity:.3}' +
        '.tapokhub-home__vcrdisp .colon circle{fill:#ff4a2a}' +
        '.tapokhub-home__vcrdisp .tape{stroke:#ff4a2a}' +
        '.tapokhub-vcr .tapokhub-home__vcrdisp{display:block}' +
        '.tapokhub-vcr .tapokhub-home__clock{display:none}' +
        '.tapokhub-home__stage::before,.tapokhub-home__stage::after{content:"";position:absolute;left:0;right:0;height:14%;z-index:1;pointer-events:none}' +
        '.tapokhub-home__stage::before{top:0;background:linear-gradient(180deg,#04040a,rgba(4,4,10,0))}' +
        '.tapokhub-home__stage::after{bottom:0;background:linear-gradient(0deg,#04040a,rgba(4,4,10,0))}' +
        '.tapokhub-home__screen{position:absolute;left:31.1%;top:19.55%;width:39.47%;height:38.79%;box-sizing:border-box;' +
            'padding-bottom:calc(var(--u)*6);' +
            'overflow:hidden;border-radius:calc(var(--u)*3.4) / calc(var(--u)*3.9);' +
            // overflow:hidden с закруглением не обрезает слои, вынесенные на видеокарту (will-change/transform) в части WebView и ТВ: снег и полоса вылезали за экран. clip-path режет надёжно.
            'clip-path:inset(0 round calc(var(--u)*3.4) / calc(var(--u)*3.9));display:flex;flex-direction:column;align-items:center;justify-content:center;' +
            'background:linear-gradient(180deg,rgba(0,15,27,.18),rgba(0,7,14,.32));box-shadow:inset 0 0 calc(var(--u)*4.4) rgba(0,0,0,.55),inset 0 0 calc(var(--u)*1.2) rgba(0,165,225,.18)}' +
        // Выпуклость кинескопа без дорогих эффектов (ни фильтров, ни размытия): светлее центр, к краям виньетка,
        // блик стекла вверху слева, тёмный внутренний край. Строки развёртки к краям гаснут (::after).
        '.tapokhub-home__screen::before{content:"";position:absolute;left:0;top:0;right:0;bottom:0;z-index:1;pointer-events:none;border-radius:inherit;' +
            'background:radial-gradient(ellipse 34% 20% at 27% 13%,rgba(255,255,255,.20),rgba(255,255,255,0) 100%),' +
                'radial-gradient(ellipse 78% 82% at 50% 46%,rgba(60,170,230,.10) 0,rgba(0,0,0,0) 46%,rgba(0,0,0,.30) 78%,rgba(0,0,0,.62) 100%)}' +
        '.tapokhub-home__screen::after{content:"";position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;opacity:.16;' +
            'background:repeating-linear-gradient(180deg,rgba(255,255,255,.10) 0,rgba(255,255,255,.10) 1px,rgba(0,0,0,.10) 2px,rgba(0,0,0,.10) 4px);' +
            '-webkit-mask-image:radial-gradient(ellipse 80% 85% at 50% 48%,#000 40%,rgba(0,0,0,.35) 100%);mask-image:radial-gradient(ellipse 80% 85% at 50% 48%,#000 40%,rgba(0,0,0,.35) 100%)}' +
        '.tapokhub-home__icon{width:calc(var(--u)*5.4);height:calc(var(--u)*5.4);margin-bottom:calc(var(--u)*.9);color:#73dcff;' +
            'filter:drop-shadow(0 0 calc(var(--u)*.3) rgba(255,255,255,.95)) drop-shadow(0 0 calc(var(--u)*.8) rgba(0,190,255,.9))}' +
        '.tapokhub-home__icon svg{display:block;width:100%;height:100%;overflow:visible;fill:none;stroke:currentColor;stroke-width:2.7;stroke-linecap:round;stroke-linejoin:round}' +
        '.tapokhub-home__label{position:relative;display:inline-block;max-width:90%;color:#fff3b0;font-family:"Courier New","Lucida Console",monospace;' +
            'font-size:calc(var(--u)*2.2);font-weight:700;line-height:1.1;letter-spacing:.065em;text-align:center;text-transform:uppercase;white-space:nowrap;' +
            'text-shadow:0 0 .14em #fff,0 0 .38em rgba(255,190,0,1),0 0 .9em rgba(255,125,0,.88),0 .08em .08em #000}' +
        '.tapokhub-home__label::after{content:"_";position:absolute;left:100%;top:0;margin-left:.18em;color:#ffe47a;animation:tapokhub-cursor 1.05s steps(1,end) infinite}' +
        '@keyframes tapokhub-cursor{0%,48%{opacity:1}49%,100%{opacity:0}}' +
        '.tapokhub-home__hint{position:absolute;left:0;right:0;bottom:calc(var(--u)*1.6);text-align:center;color:rgba(132,211,245,.58);' +
            'font-family:"Courier New",monospace;font-size:calc(var(--u)*.95);font-weight:700;letter-spacing:.14em;text-shadow:0 0 .5em rgba(0,180,255,.8)}' +
        '.tapokhub-home__hint.is-nav::before,.tapokhub-home__hint.is-nav::after{content:"";display:inline-block;vertical-align:middle;width:0;height:0;margin:0 .9em;border:solid transparent}' +
        '.tapokhub-home__hint.is-nav::before{border-width:.4em .7em .4em 0;border-right-color:currentColor}' +
        '.tapokhub-home__hint.is-nav::after{border-width:.4em 0 .4em .7em;border-left-color:currentColor}' +
        '.tapokhub-home__stats{position:absolute;left:0;right:0;bottom:calc(var(--u)*3.9);display:flex;justify-content:center;gap:calc(var(--u)*2.2);' +
            'font-family:"Courier New",monospace;text-align:center;color:rgba(132,211,245,.7)}' +
        '.tapokhub-home__stats b{display:block;font-size:calc(var(--u)*1.9);color:#fff3b0;font-weight:700;text-shadow:0 0 .4em rgba(255,190,0,.7)}' +
        '.tapokhub-home__stats span{display:block;font-size:calc(var(--u)*.72);letter-spacing:.12em}' +
        // Помехи ЭЛТ (Настройки -> TapokHub, по умолчанию выключены). Только transform и opacity: считает видеокарта,
        // основной поток не нагружается. Слои лежат внутри «стекла» и не ловят касания.
        // Огоньки соединений: наш сервер, парсер, TorrServer
        '.tapokhub-home__leds{position:absolute;left:calc(var(--u)*2.8);top:calc(var(--u)*2.4);z-index:2;pointer-events:none;font-family:"Courier New",monospace;' +
            'font-size:calc(var(--u)*.8);font-weight:700;letter-spacing:.1em;line-height:1.55;color:rgba(132,211,245,.72)}' +
        '.tapokhub-home__leds div{white-space:nowrap}' +
        '.tapokhub-home__leds b{display:inline-block;min-width:6.2em;font-weight:700}' +   // названия одной ширины: огоньки и подписи ровным столбцом

        '.tapokhub-home__leds i{display:inline-block;width:.75em;height:.75em;margin-right:.7em;border-radius:50%;background:#3a4a55;vertical-align:-.05em}' +
        '.tapokhub-home__leds .is-ok i{background:#5dff8f;box-shadow:0 0 .7em #5dff8f}' +
        '.tapokhub-home__leds .is-bad i{background:#ff4b4b;box-shadow:0 0 .7em #ff4b4b}' +
        '.tapokhub-home__leds .is-wait i{background:#ffd24a}' +
        '.tapokhub-home__leds .is-off{opacity:.55}' +
        // Область помех занимает всё «стекло», её форму (прямоугольник, углы, трапеция, выгиб) задаёт clip-path из настроек, см. TH.fx
        '.tapokhub-home__fx{display:none;position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;z-index:1;' +
            'clip-path:' + TH.fx.shape(TH.fx.defaults) + '}' +
        '.tapokhub-crt .tapokhub-home__fx{display:block}' +
        '.tapokhub-home__noise,.tapokhub-home__roll{position:absolute;pointer-events:none}' +
        '.tapokhub-home__noise{left:-30%;top:-30%;width:160%;height:160%;opacity:.075;background:url("data:image/png;base64,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");background-size:calc(var(--u)*6.4);' +
            'will-change:transform;animation:tapokhub-snow .45s steps(1,end) infinite}' +
        '.tapokhub-home__roll{left:0;right:0;top:-28%;height:24%;opacity:.16;' +
            'background:linear-gradient(180deg,rgba(150,215,255,0) 0,rgba(150,215,255,.55) 50%,rgba(150,215,255,0) 100%);will-change:transform;animation:tapokhub-roll 7.5s linear infinite}' +
        '.tapokhub-crt .tapokhub-home__screen{animation:tapokhub-flicker 3.1s steps(1,end) infinite}' +
        '.tapokhub-crt .tapokhub-home__icon,.tapokhub-crt .tapokhub-home__label{animation:tapokhub-glitch 6.8s steps(1,end) infinite}' +
        '@keyframes tapokhub-snow{0%{transform:translate(0,0)}20%{transform:translate(-7%,4%)}40%{transform:translate(5%,-9%)}60%{transform:translate(-3%,8%)}80%{transform:translate(9%,-2%)}}' +
        '@keyframes tapokhub-roll{0%{transform:translateY(0)}100%{transform:translateY(560%)}}' +
        '@keyframes tapokhub-flicker{0%{opacity:1}12%{opacity:.965}14%{opacity:1}53%{opacity:.98}55%{opacity:1}81%{opacity:.955}83%{opacity:1}}' +
        '@keyframes tapokhub-glitch{0%{transform:none}90%{transform:translateX(calc(var(--u)*-.35))}91%{transform:translateX(calc(var(--u)*.5)) skewX(-3deg)}92%{transform:translateX(calc(var(--u)*-.15))}93%{transform:none}}' +
        '@media (prefers-reduced-motion:reduce){.tapokhub-home__noise,.tapokhub-home__roll{display:none!important}.tapokhub-crt .tapokhub-home__screen,.tapokhub-crt .tapokhub-home__icon,.tapokhub-crt .tapokhub-home__label{animation:none}}' +
        // Редактор области помех (см. TH.fxEdit): рамка, ручки, панель. Поверх всего, ловит касания.
        '.tapokhub-home__fxedit{position:absolute;left:31.1%;top:19.55%;width:39.47%;height:38.79%;z-index:8}' +
        '.tapokhub-home__fxedit__outline{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none}' +
        '.tapokhub-home__fxedit__outline svg{position:absolute;left:0;top:0;overflow:visible}' +
        '.tapokhub-home__fxedit__outline polygon{fill:rgba(255,90,90,.12);stroke:#ff5a5a;stroke-width:1.6;stroke-dasharray:7 4}' +
        '.tapokhub-home__fxedit__h{position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;box-sizing:border-box;border:2px solid #fff;border-radius:50%;background:rgba(255,210,74,.92);touch-action:none;cursor:grab}' +
        '.tapokhub-home__fxedit__h.is-top,.tapokhub-home__fxedit__h.is-right,.tapokhub-home__fxedit__h.is-bottom,.tapokhub-home__fxedit__h.is-left{border-radius:6px;background:rgba(93,255,143,.92)}' +
        '.tapokhub-home__fxedit__h.is-pan{background:rgba(110,175,255,.9)}' +
        '.tapokhub-home__fxedit__h.is-sel{box-shadow:0 0 0 4px rgba(255,255,255,.55)}' +
        '.tapokhub-home__fxedit__panel{position:absolute;left:0;right:0;top:100%;margin-top:18px;text-align:center;color:#fff;font-family:"Courier New",monospace;font-size:14px}' +
        '.tapokhub-home__fxedit__readout{display:inline-block;max-width:100%;padding:6px 10px;border-radius:8px;background:rgba(0,0,0,.72)}' +
        '.tapokhub-home__fxedit__btn{display:inline-block;margin:8px 8px 0;padding:8px 18px;border-radius:8px;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.7);cursor:pointer}' +
        '.tapokhub-home__dots{position:absolute;left:0;right:0;top:calc(var(--u)*1.4);text-align:center;font-size:calc(var(--u)*1.1);letter-spacing:.5em;color:rgba(132,211,245,.35)}' +
        '.tapokhub-home__dots b{font-weight:400}' +
        '.tapokhub-home__dots .is-active{color:#ffe47a;text-shadow:0 0 .5em rgba(255,190,0,.9)}' +
    '</style>');

    $('body').append(Lampa.Template.get('tapokhub_home_css', {}, true));
};
