#!/usr/bin/env python3
"""Во сколько обходится плагин на НАТИВНЫХ экранах Lampa: CPU-метрики браузера.

  python3 plugin/tests/e2e/cost.py [cpu_throttle=4] [repeats=2]

Сценарий одинаков без плагина и с ним: главная, стрелки, открытие карточки фильма, назад,
настройки. Метрики Performance.getMetrics не зависят от GPU: скрипты, пересчёт стилей, раскладка.
"""
import sys, time, json
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
import browser as b
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys

THROTTLE = float(sys.argv[1]) if len(sys.argv) > 1 else 4
REPEATS = int(sys.argv[2]) if len(sys.argv) > 2 else 2
NONE = "https://a.pcsrf.ru/does-not-exist.js"
PLUGIN = "https://a.pcsrf.ru/tapokhub.js?v=cost"

KEYS = ["Script", "Layout", "RecalcStyle", "Task"]

def metrics(d):
    m = d.execute_cdp_cmd("Performance.getMetrics", {})["metrics"]
    return {x["name"]: x["value"] for x in m}

def press(d, seq, pause=0.3):
    k = {"R": Keys.ARROW_RIGHT, "D": Keys.ARROW_DOWN, "U": Keys.ARROW_UP, "L": Keys.ARROW_LEFT, "E": Keys.ENTER, "B": Keys.ESCAPE}
    for c in seq:
        ActionChains(d).send_keys(k[c]).perform(); time.sleep(pause)

def scenario(d):
    d.execute_script("Lampa.Controller.toggle('content')"); time.sleep(1.5)
    press(d, "RRRRRRRR"); press(d, "DDD"); press(d, "RRR"); press(d, "UUU"); press(d, "LLL")
    press(d, "E"); time.sleep(3); press(d, "DDD"); press(d, "B"); time.sleep(1.5)

def run(label, plugin):
    d = b.make_driver(1280, 720)
    try:
        b.boot(d, plugin)
        d.execute_cdp_cmd("Performance.enable", {})
        d.execute_cdp_cmd("Emulation.setCPUThrottlingRate", {"rate": THROTTLE})
        time.sleep(1)
        m0 = metrics(d); t0 = time.time()
        scenario(d)
        m1 = metrics(d); wall = time.time() - t0
        r = {k: round((m1[k + "Duration"] - m0[k + "Duration"]) * 1000) for k in KEYS}
        r["layouts"] = int(m1["LayoutCount"] - m0["LayoutCount"])
        r["restyles"] = int(m1["RecalcStyleCount"] - m0["RecalcStyleCount"])
        r["nodes"] = int(m1["Nodes"]); r["heapMB"] = round(m1["JSHeapUsedSize"] / 1e6)
        r["plugin"] = bool(d.execute_script("return !!window.TapokHub"))
        print(f"{label:14s}", json.dumps(r))
        return r
    finally:
        d.quit()

if __name__ == "__main__":
    print(f"CPU x{THROTTLE}; значения в мс (Script/Layout/RecalcStyle/Task) — чем меньше, тем лучше")
    for i in range(REPEATS):
        run(f"без плагина #{i+1}", NONE)
        run(f"с плагином  #{i+1}", PLUGIN)
