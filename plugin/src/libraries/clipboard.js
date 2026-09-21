/* ---------- буфер обмена ----------
 *
 * Читает текст из буфера обмена: вводить длинные токены пальцем или пультом неудобно, проще скопировать и вставить.
 * Работает там, где браузер разрешает navigator.clipboard (страница по https, на телефоне и компьютере обычно с запросом
 * разрешения). На телевизорах и по http чтения буфера нет: тогда done получает ошибку, а вызывающий код предлагает
 * ввод вручную. done(ошибка | null, текст без пробелов по краям)
 */
TH.clipboard = function (done) {
    var nav = typeof navigator !== 'undefined' ? navigator : null;

    if (!nav || !nav.clipboard || !nav.clipboard.readText) return done({ message: 'unsupported' }, '');

    try {
        nav.clipboard.readText().then(function (text) {
            done(null, String(text || '').trim());
        }, function (e) {
            done({ message: (e && e.name) || 'denied' }, '');
        });
    } catch (e) { done({ message: 'unsupported' }, ''); }
};
