#!/usr/bin/env python3
"""Дёргания карточек при свайпе: покадровая запись положения карточек и работы фона.

  python3 plugin/tests/e2e/jerk.py

Сравнивает варианты плагина, отключая подозреваемых во время выполнения:
  base — как есть; nobg — без смены фона по касанию/наведению; noproxy — картинки не с нашего сервера;
  nocss — без наших стилей; plain — все три сразу.
"""
import sys, time, json, statistics
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
import browser as b

P = "https://a.pcsrf.ru/tapokhub.js?v=jerk"
OPEN = "$('.menu .menu__item').filter(function(){return $(this).text().trim()=='TapokHub'}).trigger('hover:enter')"

SAMPLER = """
window.__j = {frames: [], bg: 0, draws: [], long: [], on: true};
var row = document.querySelectorAll('.activity--active .items-line')[0];
var sc = row.querySelector('.scroll--horizontal'), c0 = row.querySelectorAll('.card')[0];
var t0 = performance.now();
(function tick(now){ if(!window.__j.on) return;
  window.__j.frames.push([Math.round(now - t0), Math.round(sc.scrollLeft*10)/10, Math.round(row.getBoundingClientRect().top*10)/10, Math.round(c0.getBoundingClientRect().left*10)/10]);
  requestAnimationFrame(tick) })(t0);
var ob = Lampa.Background.change; Lampa.Background.change = function(u){ window.__j.bg++; return ob.apply(this, arguments) };
var od = CanvasRenderingContext2D.prototype.drawImage; CanvasRenderingContext2D.prototype.drawImage = function(){ var s=performance.now(); var r=od.apply(this,arguments); window.__j.draws.push(Math.round((performance.now()-s)*10)/10); return r };
try { new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ window.__j.long.push(Math.round(e.duration)) }) }).observe({entryTypes:['longtask']}) } catch(e){}
"""

def drag(d, x, y, dx, dy, steps=14, dt=0.016):
    """Настоящая цепочка касаний: палец ведёт по экрану, затем отпускает (дальше работает инерция браузера)."""
    d.execute_cdp_cmd("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for i in range(1, steps + 1):
        d.execute_cdp_cmd("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x + dx * i / steps, "y": y + dy * i / steps}]})
        time.sleep(dt)
    d.execute_cdp_cmd("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

def analyse(frames, idx):
    """idx: 1 = scrollLeft ряда (горизонталь), 2 = top ряда (вертикаль). Смотрим на равномерность движения."""
    xs = [f[idx] for f in frames]
    d = [xs[i] - xs[i-1] for i in range(1, len(xs))]
    moving = [i for i, x in enumerate(d) if abs(x) > 0.05]
    if len(moving) < 4:
        return {"moving_frames": len(moving), "total_px": round(xs[-1] - xs[0], 1)}
    seg = d[moving[0]:moving[-1] + 1]             # от начала до конца движения
    sign = 1 if sum(seg) > 0 else -1
    stalls = sum(1 for x in seg if abs(x) <= 0.05)                     # кадры «стоим», пока движение ещё идёт
    reversals = sum(1 for x in seg if x * sign < -0.3)                 # шаг назад
    med = statistics.median(abs(x) for x in seg if abs(x) > 0.05)
    spikes = sum(1 for x in seg if abs(x) > max(8, 3.0 * med))          # резкий скачок
    acc = [abs(seg[i] - seg[i-1]) for i in range(1, len(seg))]           # рывок = изменение шага между кадрами
    return {"total_px": round(xs[-1] - xs[0], 1), "moving_frames": len(seg), "stalls": stalls, "reversals": reversals, "spikes": spikes,
            "median_step": round(med, 1), "max_step": round(max(abs(x) for x in seg), 1), "mean_jerk": round(sum(acc) / max(1, len(acc)), 2)}

def run(label, disable, native=False):
    d = b.make_driver(mobile=True)
    try:
        b.boot(d, "https://a.pcsrf.ru/does-not-exist.js" if native else P, {"start_page": "main" if native else "favorite"})
        d.execute_cdp_cmd("Performance.enable", {})
        d.execute_cdp_cmd("Emulation.setCPUThrottlingRate", {"rate": 4})
        if not native:
            d.execute_script("""
              var f = arguments[0];
              if (f.indexOf('nobg') >= 0) { var oc = TapokHub.card; TapokHub.card = function(r, t){ var c = oc(r, t); delete c.params.emit.onlyFocus; delete c.params.emit.onlyHover; delete c.params.emit.onlyTouch; return c } }
              if (f.indexOf('noproxy') >= 0) TapokHub.proxy.configure('');
              if (f.indexOf('nocss') >= 0) { [].slice.call(document.querySelectorAll('style')).filter(function(x){return x.textContent.indexOf('tapokhub-card')>=0}).forEach(function(x){x.remove()}) }
            """, disable)
            d.execute_script("Lampa.Activity.push({url:'',title:'Коллекции',component:'tapokhub_collections',page:1})")
        time.sleep(10)
        out = {}
        for name, dx, dy, idx in [("горизонтальный свайп", -300, 0, 1), ("вертикальный свайп", 0, -380, 2)]:
            d.execute_script(SAMPLER); time.sleep(0.3)
            cx, cy = d.execute_script("var r=document.querySelectorAll('.activity--active .items-line')[0].querySelectorAll('.card')[1].getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]")
            drag(d, cx + (140 if dx else 0), cy + (120 if dy else 0), dx, dy)
            time.sleep(1.8)
            r = d.execute_script("window.__j.on=false; return window.__j")
            out[name] = analyse(r["frames"], idx)
            out[name].update({"смен_фона": r["bg"], "canvas": len(r["draws"]), "долгих_задач": len(r["long"])})
            d.execute_script("Lampa.Activity.backward && 0")
        print(f"\n== {label} ==")
        for k, v in out.items(): print(f"  {k}: {json.dumps(v, ensure_ascii=False)}")
        return out
    finally:
        d.quit()

if __name__ == "__main__":
    run("ЭТАЛОН: нативная главная Lampa без плагина", "", native=True)
    for label, dis in [("base: плагин как есть", ""), ("nobg: без смены фона по касанию", "nobg"), ("noproxy: картинки не с нашего сервера", "noproxy"), ("nocss: без наших стилей", "nocss")]:
        run(label, dis)
