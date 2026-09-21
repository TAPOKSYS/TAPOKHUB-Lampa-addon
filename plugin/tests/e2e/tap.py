#!/usr/bin/env python3
"""Лёгкие касания: сколько смещения пальца выдерживает тап (без фильтра и с ним).

  python3 plugin/tests/e2e/tap.py [plugin_url]

Имитирует касание через CDP: touchStart -> несколько touchMove -> touchEnd, при разной
амплитуде «дрожания». Смотрит, дошёл ли клик до карточки (hover:enter) и сколько раз.
"""
import sys, time, json, math
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
import browser as b

PLUGIN = sys.argv[1] if len(sys.argv) > 1 else "https://a.pcsrf.ru/tapokhub.js?v=tap"

def touch(d, x, y, jitter, hold=0.06, steps=4):
    """Касание: палец «дрожит» на jitter px и отпускается."""
    d.execute_cdp_cmd("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for i in range(1, steps + 1):
        dx = jitter * i / steps
        d.execute_cdp_cmd("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x + dx, "y": y + dx * 0.4}]})
        time.sleep(hold / steps)
    d.execute_cdp_cmd("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

def card_center(d):
    return d.execute_script("""var c=document.querySelector('.activity--active .card'); var r=c.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]""")

def probe(d, jitter):
    d.execute_script("""
      var c=document.querySelector('.activity--active .card');
      window.__tap = {native: 0, enter: 0}; 
      if(!window.__tapBound){ window.__tapBound = true;
        document.addEventListener('click', function(e){ if(e.isTrusted) window.__tap.native++ }, true);
        document.addEventListener('hover:enter', function(){ window.__tap.enter++ }, true);
      }""")
    x, y = card_center(d)
    touch(d, x, y, jitter)
    time.sleep(0.9)
    r = d.execute_script("var t=window.__tap; var a=Lampa.Activity.active().component; return {native:t.native, enter:t.enter, screen:a}")
    if r["screen"] not in ("tapokhub_collections",):   # тап открыл карточку — вернуться
        d.execute_script("Lampa.Activity.backward()"); time.sleep(1.5)
    return r

def swipe_check(d):
    """Обычная прокрутка по карточке не должна засчитываться как тап."""
    d.execute_script("window.__tap.enter = 0; window.__tap.native = 0")
    x, y = card_center(d)
    for _ in range(4):
        d.execute_cdp_cmd("Input.synthesizeScrollGesture", {"x": x, "y": y, "yDistance": -300, "speed": 1200, "gestureSourceType": "touch"})
        time.sleep(0.6)
    d.execute_cdp_cmd("Input.synthesizeScrollGesture", {"x": x, "y": y, "xDistance": -250, "speed": 1200, "gestureSourceType": "touch"})
    time.sleep(1)
    return d.execute_script("return window.__tap.enter")

if __name__ == "__main__":
    d = b.make_driver(mobile=True)
    try:
        b.boot(d, PLUGIN)
        print("по умолчанию Storage.field('tapokhub_touch') =", repr(d.execute_script("return Lampa.Storage.field('tapokhub_touch')")))
        d.execute_script("$('.menu .menu__item').filter(function(){return $(this).text().trim()=='Коллекции'}).trigger('hover:enter')")
        time.sleep(6)
        for setting, label in [("0", "Выключено"), ("20", "Среднее (по умолчанию)"), ("32", "Сильное")]:
            d.execute_script("Lampa.Storage.set('tapokhub_touch', arguments[0])", setting)
            print(f"\n== сглаживание: {label} ({setting} px) ==")
            print("смещение пальца |  click от браузера | hover:enter")
            for j in [0, 6, 12, 16, 20, 26, 34]:
                r = probe(d, j)
                verdict = "✓" if r["enter"] == 1 else ("✗ потерян" if r["enter"] == 0 else "⚠ ДВОЙНОЙ")
                print(f"{j:>8} px      |  {r['native']}                 | {r['enter']} {verdict}")
        d.execute_script("Lampa.Storage.set('tapokhub_touch', '20')")
        print("\nсвайпы (4 вертикальных + 1 горизонтальный) по карточке засчитаны как тап:", swipe_check(d), "раз (должно быть 0)")
        print("спасено фильтром за сессию:", d.execute_script("return window.TapokHub.touch.rescued()"))
    finally:
        d.quit()
