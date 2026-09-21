#!/usr/bin/env python3
"""Замер плавности: одинаковая последовательность стрелок на экране, время кадров и долгие задачи.

  python3 plugin/tests/e2e/bench.py [cpu_throttle=4]

Сравнивает нативную главную Lampa и нашу вкладку «Коллекции». В headless нет GPU,
поэтому абсолютные числа ничего не значат; важна разница между экранами.
"""
import sys, time, json
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
import browser as b
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys

THROTTLE = float(sys.argv[1]) if len(sys.argv) > 1 else 4

SAMPLER = """
window.__t = {frames: [], long: [], on: true};
var last = performance.now();
(function tick(now){ if(!window.__t.on) return; window.__t.frames.push(now - last); last = now; requestAnimationFrame(tick) })(last);
try { new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ window.__t.long.push(Math.round(e.duration)) }) }).observe({entryTypes:['longtask']}) } catch(e){}
"""

def stats(frames, long):
    f = sorted(frames[3:]) or [0]
    q = lambda p: round(f[min(len(f)-1, int(len(f)*p))], 1)
    return {"frames": len(f), "p50": q(.5), "p95": q(.95), "p99": q(.99), "max": round(f[-1], 1),
            "over50ms": sum(1 for x in f if x > 50), "over100ms": sum(1 for x in f if x > 100),
            "longtasks": len(long), "longtask_ms_total": sum(long)}

def run_keys(d, seq, pause=0.35):
    keys = {"R": Keys.ARROW_RIGHT, "D": Keys.ARROW_DOWN, "U": Keys.ARROW_UP, "L": Keys.ARROW_LEFT}
    for k in seq:
        ActionChains(d).send_keys(keys[k]).perform()
        time.sleep(pause)

def measure(d, label, seq):
    d.execute_script(SAMPLER)
    time.sleep(0.5)
    run_keys(d, seq)
    time.sleep(1.5)
    r = d.execute_script("window.__t.on=false; return {frames: window.__t.frames, long: window.__t.long}")
    s = stats(r["frames"], r["long"])
    print(f"{label:34s}", json.dumps(s))
    return s

SEQ = "RRRRRRDRRRRDRRRUUULLLL"

d = b.make_driver(1280, 720)
try:
    b.boot(d)
    d.execute_cdp_cmd("Emulation.setCPUThrottlingRate", {"rate": THROTTLE})
    print(f"CPU throttle x{THROTTLE}, keys: {SEQ}")

    # 1. нативная главная (в ней есть и наши ряды, но берём верх — нативные)
    d.execute_script("Lampa.Controller.toggle('content')")
    time.sleep(2)
    measure(d, "главная (нативные ряды)", SEQ)

    # 2. наша вкладка
    d.execute_script("$('.menu .menu__item').filter(function(){return $(this).text().trim()=='Коллекции'}).trigger('hover:enter')")
    time.sleep(6)
    d.execute_script("Lampa.Controller.toggle('content')")
    time.sleep(1)
    measure(d, "вкладка «Коллекции»", SEQ)
finally:
    d.quit()
