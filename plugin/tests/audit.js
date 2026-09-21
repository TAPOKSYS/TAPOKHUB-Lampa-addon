'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function device(storage = {}) {
    const listeners = [], timers = new Map();
    let id = 0;
    const ctx = {
        console, Date,
        setTimeout(fn) { timers.set(++id, fn); return id; },
        clearTimeout(id) { timers.delete(id); },
        TH: { proxyHost: 'https://hub.test', fx: { defaults: { left: 12 } }, log() {} },
        Lampa: {
            Storage: {
                get(k, d) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : d; },
                set(k, v, silent) {
                    storage[k] = JSON.parse(JSON.stringify(v));
                    if (!silent) listeners.forEach(fn => fn({ name: k, value: v }));
                },
                listener: { follow(event, fn) { listeners.push(fn); } }
            },
            Reguest: function () { this.timeout = function () {}; this.silent = (url, ok) => ok({ ok: true }); },
            Account: { Permit: { token: 'cub' } }, Manifest: { cub_domain: 'cub.test' }
        }
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const file of ['core/i18n.js', 'core/proxy.js', 'core/auth.js', 'modules/sync.js', 'modules/play.js', 'modules/library/api.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), ctx);
    }
    const calls = [];
    let transport = (method, url, body, done) => done(null, {});
    ctx.TH.lib.transport = (method, url, body, done) => {
        calls.push({ method, url, body });
        transport(method, url, body, done);
    };
    ctx.TH.sync.install();
    return {
        ...ctx, storage, calls, timers,
        respond(fn) { transport = fn; },
        login(token) { ctx.Lampa.Storage.set('tapokhub_token', token); ctx.TH.auth.apply(); },
        cache() { return storage[ctx.TH.play.storageKey()] || {}; }
    };
}

let failed = 0;
function test(name, fn) {
    try { fn(); console.log('ok   ', name); }
    catch (e) { failed++; console.error('FAIL ', name, '\n', e.stack); }
}

test('смена аккаунта изолирует торренты, настройки и отложенные ответы', () => {
    const d = device({ tapokhub_torrents: { 'movie:99': { MagnetUri: 'legacy-secret' } } });
    d.login('A');
    d.respond((m, url, body, done) => {
        if (m === 'POST' && url.endsWith('/torrents')) done(null, { at: 123 });
        else done(null, { items: [], settings: {} });
    });
    d.TH.play.remember({ MagnetUri: 'private-A' }, { id: 11 });
    d.Lampa.Storage.set('tapokhub_fx_left', '31');
    let oldReply;
    d.respond((m, url, body, done) => { oldReply = done; });
    d.TH.sync.flush();
    d.TH.auth.logout();
    d.respond((m, url, body, done) => {
        if (url.endsWith('/auth/cub')) done(null, { token: 'B', user: { id: 2 } });
        else done(null, { items: [], settings: {} });
    });
    d.TH.auth.loginCub(() => {});
    oldReply(null, { saved: { tapokhub_fx_left: 999 } });
    assert.equal(d.TH.play.saved({ id: 11 }), null);
    assert.equal(d.TH.play.saved({ id: 99 }), null);
    assert.equal(d.storage.tapokhub_fx_left, '12');
    assert(!d.calls.some(c => c.method === 'POST' && c.url.includes('/tmdb/B/lib/')));
    assert.equal(d.storage.tapokhub_settings_meta.tapokhub_fx_left, undefined);
    d.login('A');
    assert.equal(d.TH.play.saved({ id: 11 }).MagnetUri, 'private-A');
    assert.equal(d.storage.tapokhub_fx_left, '31');
    assert.equal(d.storage.tapokhub_settings_pending.tapokhub_fx_left, '31');
});

test('удаление на первом устройстве не восстанавливается вторым', () => {
    let remote = [], posts = 0;
    function transport(m, url, body, done) {
        if (url.endsWith('/torrents/forget')) { remote = []; done(null, { deleted: 1 }); }
        else if (m === 'POST' && url.endsWith('/torrents')) {
            posts++;
            remote = [{ ...body, at: 100 }];
            done(null, remote[0]);
        } else done(null, { items: remote });
    }
    const a = device(), b = device();
    a.login('same'); b.login('same'); a.respond(transport); b.respond(transport);
    a.TH.play.remember({ MagnetUri: 'magnet:test' }, { id: 1 });
    b.TH.play.sync(true);
    assert(b.TH.play.saved({ id: 1 }));
    a.TH.play.forget();
    b.TH.play.sync(true);
    assert.equal(b.TH.play.saved({ id: 1 }), null);
    assert.equal(posts, 1);
    assert.equal(remote.length, 0);
});

test('поздний GET не удаляет выбор, подтверждённый после начала запроса', () => {
    const d = device(); d.login('A');
    let post, get;
    d.respond((m, url, body, done) => { if (m === 'POST') post = done; else get = done; });
    d.TH.play.remember({ MagnetUri: 'new-choice' }, { id: 1 });
    d.TH.play.sync(true);
    post(null, { at: 100 });
    get(null, { items: [] });
    assert.equal(d.TH.play.saved({ id: 1 }).MagnetUri, 'new-choice');
});

test('ошибка удаления сохраняет локальный кеш и возвращает ошибку', () => {
    const d = device(); d.login('A');
    d.TH.play.remember({ MagnetUri: 'm' }, { id: 1 });
    d.respond((m, url, body, done) => done({ status: 0 }, null));
    let error;
    d.TH.play.forget(err => { error = err; });
    assert(error);
    assert(d.TH.play.saved({ id: 1 }));
});

test('настройки повторяются после сбоя и после перезапуска приложения', () => {
    const d = device(); d.login('A');
    d.storage.tapokhub_settings_meta = { tapokhub_play_auto: 10 };
    d.Lampa.Storage.set('tapokhub_play_auto', 'false');
    d.respond((m, url, body, done) => done({ status: 0 }, null));
    d.TH.sync.flush();
    assert.equal(d.storage.tapokhub_settings_pending.tapokhub_play_auto, 'false');
    const restarted = device(d.storage); restarted.login('A');
    restarted.respond((m, url, body, done) => {
        if (m === 'GET') done(null, { settings: { tapokhub_play_auto: { value: 'true', at: 20 } } });
        else { assert.equal(body.settings.tapokhub_play_auto, 'false'); done(null, { saved: { tapokhub_play_auto: 30 } }); }
    });
    restarted.TH.sync.pull(true);
    assert.equal(restarted.storage.tapokhub_play_auto, 'false');
    assert.equal(restarted.storage.tapokhub_settings_pending.tapokhub_play_auto, undefined);
    assert.equal(restarted.storage.tapokhub_settings_meta.tapokhub_play_auto, 30);
});

test('старое подтверждение настроек не теряет новое изменение того же ключа', () => {
    const d = device(); d.login('A');
    let reply;
    d.respond((m, url, body, done) => { reply = done; });
    d.Lampa.Storage.set('tapokhub_fx_left', '20'); d.TH.sync.flush();
    d.Lampa.Storage.set('tapokhub_fx_left', '40');
    reply(null, { saved: { tapokhub_fx_left: 10 } });
    assert.equal(d.storage.tapokhub_settings_pending.tapokhub_fx_left, '40');
    d.respond((m, url, body, done) => {
        assert.equal(body.settings.tapokhub_fx_left, '40'); done(null, { saved: { tapokhub_fx_left: 11 } });
    });
    d.TH.sync.flush();
    assert.equal(d.storage.tapokhub_settings_pending.tapokhub_fx_left, undefined);
});

test('поздний ответ входа после выхода не восстанавливает аккаунт', () => {
    const d = device(); d.login('A');
    let reply;
    d.respond((m, url, body, done) => { reply = done; });
    d.TH.auth.setToken('B', () => {});
    assert(d.TH.proxy.base().endsWith('/A'));
    d.TH.auth.logout();
    reply(null, { id: 2 });
    assert.equal(d.TH.proxy.base(), '');
    assert.equal(d.storage.tapokhub_token, '');
});

console.log(failed ? failed + ' FAILED' : 'audit regressions: all passed');
process.exitCode = failed ? 1 : 0;
