'use strict';
// Языки интерфейса плагина: выбор языка, подстановки, формы числа и полнота английского каталога.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '../src');

function load(language) {
    const storage = { language };
    const ctx = { TH: {}, Lampa: { Storage: { get(k, d) { return storage[k] === undefined ? d : storage[k]; } } } };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const file of ['core/i18n.js', 'core/i18n-en.js']) vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), ctx);
    return ctx;
}

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

let failed = 0;
function test(name, fn) {
    try { fn(); console.log('ok   ', name); }
    catch (e) { failed++; console.error('FAIL ', name, '\n', e.stack); }
}

test('язык интерфейса берётся из настройки Lampa: ru, uk и be дают русский, остальные английский', () => {
    for (const [code, want] of [['ru', 'ru'], ['uk', 'ru'], ['be', 'ru'], ['en', 'en'], ['de', 'en'], ['pt-BR', 'en'], ['', 'ru'], [undefined, 'ru']]) {
        assert.strictEqual(load(code).TH.lang(), want, String(code));
    }
});

test('TH.i18n.force задаёт язык независимо от Lampa', () => {
    const { TH } = load('ru');
    TH.i18n.force('en');
    assert.strictEqual(TH.lang(), 'en');
    TH.i18n.force('');
    assert.strictEqual(TH.lang(), 'ru');
});

test('TH.t: русский возвращает ключ, английский перевод, нет перевода: ключ; подстановки {имя}', () => {
    const ru = load('ru').TH, en = load('en').TH;
    assert.strictEqual(ru.t('Библиотека'), 'Библиотека');
    assert.strictEqual(en.t('Библиотека'), 'Library');
    assert.strictEqual(en.t('нет такого текста в каталоге'), 'нет такого текста в каталоге');
    assert.strictEqual(en.t('Найдено: {n} из {total} {x}', { n: 5, total: 7 }), 'Найдено: 5 из 7 {x}');
});

test('TH.plural: русские три формы и английские две', () => {
    const ru = load('ru').TH, en = load('en').TH;
    const forms = ['позиция', 'позиции', 'позиций'];
    assert.deepStrictEqual([1, 2, 5, 11, 21, 22, 25, 111].map(n => ru.plural(n, forms)),
        ['позиция', 'позиции', 'позиций', 'позиций', 'позиция', 'позиции', 'позиций', 'позиций']);
    assert.deepStrictEqual([0, 1, 2, 5, 21].map(n => en.plural(n, forms)), ['items', 'item', 'items', 'items', 'items']);
});

test('каждый текст TH.t(...) в plugin/src есть в английском каталоге, и в каталоге нет лишних', () => {
    const catalog = load('en').TH.i18n.en;
    const used = new Set();
    const re = /TH\.t\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g;

    for (const file of walk(SRC).filter(f => f.endsWith('.js') && !/core[\\/]i18n/.test(f))) {
        const text = fs.readFileSync(file, 'utf8');
        let m;
        while ((m = re.exec(text))) used.add(vm.runInNewContext(m[1]));
    }

    const missing = [...used].filter(k => !Object.prototype.hasOwnProperty.call(catalog, k));
    const stale = Object.keys(catalog).filter(k => !used.has(k));
    assert.deepStrictEqual(missing, [], 'нет перевода: ' + missing.join(' | '));
    assert.deepStrictEqual(stale, [], 'лишние ключи каталога: ' + stale.join(' | '));
    assert.ok(used.size > 250, 'найдено текстов: ' + used.size);
});

test('в английских текстах нет кириллицы, а подстановочные части не потеряны', () => {
    const catalog = load('en').TH.i18n.en;
    const bad = Object.entries(catalog).filter(([k, v]) => /[А-Яа-яЁё]/.test(v) || !v.trim());
    assert.deepStrictEqual(bad, []);
    for (const [k, v] of Object.entries(catalog)) {
        assert.deepStrictEqual((k.match(/\{\w+\}/g) || []).sort(), (v.match(/\{\w+\}/g) || []).sort(), k);
    }
});

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('i18n: all passed');
