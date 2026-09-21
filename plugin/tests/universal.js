'use strict';
// Общая сборка плагина (TH.universal): адрес сервера вводится в настройках, проверяется и сохраняется; картинки берутся с сервера.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function device(storage = {}, universal = true, proxyHost = '', location = undefined) {
    const ctx = {
        console, Date, setTimeout, clearTimeout,
        TH: { universal, proxyHost, version: '9.9.9', assetsBase: '', assetsVersion: '', log() {}, homeCss() { this.homeCssCalls = (this.homeCssCalls || 0) + 1; } },
        Lampa: { Storage: { get(k, d) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : d; }, set(k, v) { storage[k] = v; } } }
    };
    if (location) ctx.location = location;
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const file of ['core/core.js', 'core/i18n.js', 'core/i18n-en.js', 'core/proxy.js', 'core/auth.js']) {
        // core.js создаёт свой TH: берём из него только assetUrl
        const src = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
        if (file === 'core/core.js') {
            const m = src.match(/TH\.assetUrl = function[\s\S]*?\n};\n/);
            vm.runInContext(m[0], ctx);
        } else vm.runInContext(src, ctx);
    }
    const calls = [];
    let answer = () => [null, { ok: true, version: '0.9.0-pre.5' }];
    ctx.TH.lib = { transport(method, url, body, done) { calls.push({ method, url }); const [err, data] = answer(url); done(err, data); } };
    ctx.TH.proxy.configure = function (base) { calls.push({ configure: base }); };
    return { ...ctx, storage, calls, answer(fn) { answer = fn; } };
}

let failed = 0;
function test(name, fn) {
    try { fn(); console.log('ok   ', name); }
    catch (e) { failed++; console.error('FAIL ', name, '\n', e.stack); }
}

test('адрес: без схемы https, хвосты и слэши убираются, мусор отвергается', () => {
    const { TH } = device();
    const n = TH.auth.normalizeServer;
    assert.strictEqual(n('tapok.example.com'), 'https://tapok.example.com');
    assert.strictEqual(n('  https://tapok.example.com/  '), 'https://tapok.example.com');
    assert.strictEqual(n('https://tapok.example.com/tapokhub.js'), 'https://tapok.example.com');
    assert.strictEqual(n('http://192.168.1.5:8080'), 'http://192.168.1.5:8080');
    for (const bad of ['', '   ', 'ftp://x.example.com', 'https://a b', 'https://', 'https://x.example.com/path', 'javascript:alert(1)', 'https://x.example.com:99999x']) {
        assert.strictEqual(n(bad), '', bad);
    }
});

test('без адреса сервера общая сборка не подменяет ничего и не показывает картинок', () => {
    const { TH } = device();
    assert.strictEqual(TH.auth.host(), '');
    assert.strictEqual(TH.assetUrl('menu-background.jpg'), '');
});

test('setServer: проверяет /healthz, сохраняет адрес, включает подмены, картинки идут с сервера', () => {
    const d = device();
    let result;
    d.TH.auth.setServer('tapok.example.com', (err, addr) => { result = [err, addr]; });
    assert.deepStrictEqual(result, [null, 'https://tapok.example.com']);
    assert.deepStrictEqual(d.calls[0], { method: 'GET', url: 'https://tapok.example.com/healthz' });
    assert.strictEqual(d.storage.tapokhub_server_url, 'https://tapok.example.com');
    assert.strictEqual(d.TH.auth.host(), 'https://tapok.example.com');
    assert.strictEqual(d.TH.assetUrl('menu-background.jpg'), 'https://tapok.example.com/tapokhub-assets/menu-background.jpg?v=9.9.9');
    assert.strictEqual(d.TH.homeCssCalls, 1, 'картинка хаба берётся заново');
});

test('setServer: неверный адрес, чужой сервер и сеть ничего не сохраняют', () => {
    const d = device();
    const run = input => { let r; d.TH.auth.setServer(input, (err, addr) => { r = [err, addr]; }); return r; };
    assert.strictEqual(run('не адрес')[0].message, 'bad address');
    d.answer(() => [null, { ok: true }]);                                       // отвечает что-то без версии
    assert.strictEqual(run('a.example.com')[0].message, 'not tapokhub');
    d.answer(() => [{ status: 404, message: 'x' }, null]);                       // 404: старый сервер без /healthz
    assert.strictEqual(run('a.example.com')[0].status, 404);
    d.answer(() => [{ status: 0, message: 'network' }, null]);
    assert.strictEqual(run('a.example.com')[0].message, 'network');
    assert.strictEqual(d.storage.tapokhub_server_url, undefined);
    assert.strictEqual(d.TH.auth.host(), '');
    assert.strictEqual(d.TH.auth.explain({ status: 0, message: 'bad address' }).includes('https://tapok.example.com'), true);
});

test('setServer: http-сервер из страницы https объясняется отдельным сообщением', () => {
    const d = device({}, true, '', { protocol: 'https:' });
    d.answer(() => [{ status: 0, message: 'network' }, null]);
    let r;
    d.TH.auth.setServer('http://192.168.1.5', (err) => { r = err; });
    assert.strictEqual(r.message, 'mixed');
    assert.ok(/https/.test(d.TH.auth.explain(r)));
});

test('смена сервера сбрасывает токен прежнего, тот же адрес токен не трогает', () => {
    const d = device({ tapokhub_server_url: 'https://old.example.com', tapokhub_token: 'tok-old' });
    d.TH.auth.setServer('https://old.example.com', () => {});
    assert.strictEqual(d.storage.tapokhub_token, 'tok-old');
    d.TH.auth.setServer('https://new.example.com', () => {});
    assert.strictEqual(d.storage.tapokhub_token, '');
    assert.strictEqual(d.storage.tapokhub_server_url, 'https://new.example.com');
});

test('в сборке с вшитым адресом введённый адрес игнорируется, а в общей вшитого нет', () => {
    const baked = device({ tapokhub_server_url: 'https://other.example.com' }, false, 'https://baked.example.com');
    assert.strictEqual(baked.TH.auth.host(), 'https://baked.example.com');
    const plain = device({ tapokhub_server_url: 'https://other.example.com' }, false, '');
    assert.strictEqual(plain.TH.auth.host(), '', 'необщая сборка без адреса: сервер не выбирается');
});

// ---- токен аккаунта CUB уходит на введённый руками адрес только с согласия человека

function cubDevice(storage = {}, universal = true, proxyHost = '') {
    const d = device(storage, universal, proxyHost);
    const shown = [];
    d.Lampa.Select = { show(o) { shown.push(o); } };
    d.Lampa.Controller = { enabled() { return { name: 'settings' }; }, toggle() {} };
    d.Lampa.Account = { Permit: { token: 'cub-secret' } };
    d.Lampa.Manifest = { cub_domain: 'cub.test' };
    d.Lampa.Noty = { show() {} };
    d.shown = shown;
    d.posts = () => d.calls.filter(c => c.method === 'POST' && /\/tmdb\/auth\/cub$/.test(c.url));
    return d;
}

test('введённый руками адрес: токен CUB не уходит, пока человек не согласился', () => {
    const d = cubDevice();
    d.TH.auth.setServer('tapok.example.com', () => {});
    d.TH.auth.autoLogin(true);
    assert.strictEqual(d.shown.length, 1, 'показан вопрос');
    assert.ok(d.shown[0].title.indexOf('https://tapok.example.com') !== -1, 'в вопросе адрес сервера');
    assert.strictEqual(d.posts().length, 0, 'до ответа токен не отправлен');
    d.shown[0].onSelect(d.shown[0].items.find(i => i.ok === false));
    assert.strictEqual(d.posts().length, 0, 'отказ: токен не отправлен');
    assert.strictEqual(d.storage.tapokhub_cub_trusted, undefined, 'и доверие не записано');
});

test('согласие: токен уходит один раз, адрес запоминается и больше не спрашивают', () => {
    const d = cubDevice();
    d.TH.auth.setServer('tapok.example.com', () => {});
    d.TH.auth.autoLogin(true);
    d.shown[0].onSelect(d.shown[0].items.find(i => i.ok === true));
    assert.strictEqual(d.posts().length, 1);
    assert.strictEqual(d.storage.tapokhub_cub_trusted, 'https://tapok.example.com');
    assert.strictEqual(d.TH.auth.trusted(), true);
    d.TH.auth.autoLogin();
    assert.strictEqual(d.shown.length, 1, 'второго вопроса нет');
    assert.strictEqual(d.posts().length, 2, 'подтверждённому серверу входят сразу');
});

test('тихий вход при запуске неподтверждённый адрес не трогает и вопросов не задаёт', () => {
    const d = cubDevice({ tapokhub_server_url: 'https://tapok.example.com' });
    d.TH.auth.autoLogin();
    assert.strictEqual(d.shown.length, 0);
    assert.strictEqual(d.posts().length, 0);
});

test('доверие относится к одному адресу: новый сервер спрашивают заново', () => {
    const d = cubDevice({ tapokhub_server_url: 'https://new.example.com', tapokhub_cub_trusted: 'https://old.example.com' });
    assert.strictEqual(d.TH.auth.trusted(), false);
    d.TH.auth.confirmCub(() => { throw new Error('не должно вызываться без согласия'); });
    assert.strictEqual(d.shown.length, 1);
});

test('адрес по http: в вопросе есть предупреждение, что токен идёт открыто', () => {
    const d = cubDevice({ tapokhub_server_url: 'http://192.168.1.5' });
    d.TH.auth.confirmCub(() => {});
    assert.ok(d.shown[0].items.some(i => /без https|not https/.test(i.title)), 'предупреждение показано');
});

test('вшитый адрес (плагин взят с самого сервера): вход без вопроса', () => {
    const d = cubDevice({}, false, 'https://baked.example.com');
    assert.strictEqual(d.TH.auth.trusted(), true);
    d.TH.auth.autoLogin();
    assert.strictEqual(d.shown.length, 0);
    assert.strictEqual(d.posts().length, 1);
});

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('universal: all passed');
