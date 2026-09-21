#!/usr/bin/env python3
"""Плавность на «телефоне» пользователя: свайпы по нативным экранам, нашей вкладке и экрану «Ещё».

  python3 plugin/tests/e2e/mobile.py [cpu_throttle=4] [plugin_url]

CPU-метрики (Script/Layout/RecalcStyle/Task) не зависят от GPU; кадры в headless без GPU
показывают только нагрузку главного потока.
"""
import sys, time, json
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
import browser as b

THROTTLE = float(sys.argv[1]) if len(sys.argv) > 1 else 4
PLUGIN = sys.argv[2] if len(sys.argv) > 2 else "https://a.pcsrf.ru/tapokhub.js?v=mobile"

SAMPLER = """
window.__t = {frames: [], long: [], on: true};
var last = performance.now();
(function tick(now){ if(!window.__t.on) return; window.__t.frames.push(now - last); last = now; requestAnimationFrame(tick) })(last);
try { new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ window.__t.long.push(Math.round(e.duration)) }) }).observe({entryTypes:['longtask']}) } catch(e){}
"""

def metrics(d):
    return {x["name"]: x["value"] for x in d.execute_cdp_cmd("Performance.getMetrics", {})["metrics"]}

def swipe(d, dy, dx=0, x=206, y=600):
    d.execute_cdp_cmd("Input.synthesizeScrollGesture", {"x": x, "y": y, "yDistance": dy, "xDistance": dx,
                                                        "speed": 1500, "gestureSourceType": "touch"})

def phase(d, label, action):
    d.execute_script(SAMPLER); time.sleep(0.4)
    m0 = metrics(d)
    action()
    time.sleep(1.0)
    m1 = metrics(d)
    r = d.execute_script("window.__t.on=false; return {f: window.__t.frames, l: window.__t.long}")
    f = sorted(r["f"][3:]) or [0]
    q = lambda p: round(f[min(len(f)-1, int(len(f)*p))], 1)
    cpu = {k: round((m1[k + "Duration"] - m0[k + "Duration"]) * 1000) for k in ("Script", "Layout", "RecalcStyle", "Task")}
    print(f"{label:34s} кадры p50={q(.5)} p95={q(.95)} max={round(f[-1],1)} >50мс={sum(1 for x in f if x>50)}"
          f" долгих задач={len(r['l'])}({sum(r['l'])}мс) | CPU мс: {cpu} layouts={int(m1['LayoutCount']-m0['LayoutCount'])}")

def open_tab(d):
    d.execute_script("$('.menu .menu__item').filter(function(){return $(this).text().trim()=='Коллекции'}).trigger('hover:enter')")
    time.sleep(6)

def press_more(d, nth=0):
    return d.execute_script("""
      var b = document.querySelectorAll('.activity--active .items-line__more');
      if(!b.length) return 'нет кнопки Ещё';
      b[arguments[0]].dispatchEvent(new Event('hover:enter',{bubbles:true})); return Lampa.Activity.active().component""", nth)

if __name__ == "__main__":
    d = b.make_driver(mobile=True)
    try:
        b.boot(d, PLUGIN)
        d.execute_cdp_cmd("Performance.enable", {})
        d.execute_cdp_cmd("Emulation.setCPUThrottlingRate", {"rate": THROTTLE})
        print(f"телефон 412x915@2.625, CPU x{THROTTLE}")
        time.sleep(1)

        phase(d, "нативная главная: 5 свайпов вниз", lambda: [swipe(d, -450) or time.sleep(0.5) for _ in range(5)])
        print("  нативный «Ещё» до:", press_more(d, 0)); time.sleep(4); print("  ->", d.execute_script("return Lampa.Activity.active().component"))
        phase(d, "нативный «Ещё»: 5 свайпов", lambda: [swipe(d, -450) or time.sleep(0.5) for _ in range(5)])
        b.shot(d, "m03-native-more")
        d.execute_script("Lampa.Activity.backward()"); time.sleep(1.5)

        open_tab(d)
        phase(d, "НАША вкладка: 4 свайпа вниз", lambda: [swipe(d, -450) or time.sleep(0.5) for _ in range(4)])
        phase(d, "НАША вкладка: 4 свайпа вбок (ряд)", lambda: [swipe(d, 0, -300, x=300, y=500) or time.sleep(0.5) for _ in range(4)])
        d.execute_script("document.querySelector('.activity--active .scroll__body') && (document.querySelector('.activity--active .scroll__body').style.transform='')")
        print("  наш «Ещё» до:", press_more(d, 0)); time.sleep(3)
        b.shot(d, "m04-our-more")
        print("  активность:", d.execute_script("return Lampa.Activity.active().component"),
              "| карточек:", d.execute_script("return document.querySelectorAll('.activity--active .card').length"))
        phase(d, "НАШ «Ещё»: 5 свайпов", lambda: [swipe(d, -450) or time.sleep(0.5) for _ in range(5)])
        for l in b.console(d):
            if "SEVERE" in l and ("TapokHub" in l or "Uncaught" in l and "AndroidJS" not in l): print(l)
    finally:
        d.quit()
