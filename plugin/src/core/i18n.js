/* ---------- языки интерфейса ----------
 *
 * Тексты плагина написаны по-русски, русский текст служит ключом: TH.t('Библиотека'). Для английского языка перевод
 * берётся из каталога TH.i18n.en (core/i18n-en.js); нет перевода — показывается ключ, то есть русский текст.
 * Язык выбирается по настройке Lampa «Язык» (Lampa.Storage 'language'): русский, украинский и белорусский дают русский
 * интерфейс, остальные языки английский. TH.i18n.force('ru' | 'en') задаёт язык принудительно (тесты, отладка).
 * Подстановки: TH.t('Найдено: {n}', { n: 5 }).
 */

TH.i18n = { en: {}, forced: '' };

TH.i18n.force = function (lang) {
    TH.i18n.forced = lang || '';
};

// 'ru' или 'en'
TH.lang = function () {
    if (TH.i18n.forced) return TH.i18n.forced;

    var code = '';

    try { code = Lampa.Storage.get('language', ''); } catch (e) { /* без Lampa обойдёмся */ }

    if (!code && typeof navigator !== 'undefined') code = navigator.language || '';

    code = String(code || 'ru').split(/[-_]/)[0].toLowerCase();

    return ['ru', 'uk', 'be'].indexOf(code) >= 0 ? 'ru' : 'en';
};

TH.t = function (key, vars) {
    var text = key;

    if (TH.lang() === 'en' && Object.prototype.hasOwnProperty.call(TH.i18n.en, key)) text = TH.i18n.en[key];

    if (vars) text = text.replace(/\{(\w+)\}/g, function (m, name) { return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m; });

    return text;
};

// Форма слова по числу. forms: три русские формы ['позиция', 'позиции', 'позиций']; для английского берётся перевод
// первой (одно) или второй (несколько) формы.
TH.plural = function (n, forms) {
    if (TH.lang() === 'en') return TH.t(forms[n === 1 ? 0 : 1]);

    var m10 = n % 10;
    var m100 = n % 100;

    return forms[m100 > 10 && m100 < 20 ? 2 : (m10 === 1 ? 0 : (m10 >= 2 && m10 <= 4 ? 1 : 2))];
};
