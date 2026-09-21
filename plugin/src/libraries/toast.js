/* ---------- уведомление сверху ----------
 *
 * Уведомления Lampa (Noty) появляются внизу и на телефоне перекрываются нижней панелью. Свои сообщения о запуске торрента
 * показываем сверху под шапкой; без страницы (тесты, ранний запуск) остаётся штатное Lampa.Noty.
 */
TH.toast = function (text, ms) {
    var body = typeof document !== 'undefined' && document.body;

    if (!body || !document.createElement) {
        try { Lampa.Noty.show(text); } catch (e) { /* без уведомления обойдёмся */ }

        return;
    }

    var el = TH.toast.el;

    if (!el) {
        el = TH.toast.el = document.createElement('div');
        body.appendChild(el);
    }

    el.textContent = text;
    el.className = 'tapokhub-toast is-on';

    clearTimeout(TH.toast.timer);
    TH.toast.timer = setTimeout(function () { el.className = 'tapokhub-toast'; }, ms || 4500);
};
