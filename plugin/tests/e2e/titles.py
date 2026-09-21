#!/usr/bin/env python3
"""Ровность подписей под постерами: y-координата строки с годом у карточек одного ряда.

  python3 plugin/tests/e2e/titles.py [plugin_url]
"""
import sys, time, json
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
import browser as b

d = b.make_driver(1280, 720)
try:
    b.boot(d, *sys.argv[1:2])
    d.execute_script("$('.menu .menu__item').filter(function(){return $(this).text().trim()=='Коллекции'}).trigger('hover:enter')")
    time.sleep(6)
    rows = d.execute_script("""
      return [].slice.call(document.querySelectorAll('.activity--active .items-line')).map(function(l){
        var cards = [].slice.call(l.querySelectorAll('.card'));
        return {
          title: (l.querySelector('.tapokhub-logo') || {alt: l.querySelector('.items-line__title').textContent}).alt,
          ages: cards.map(function(c){ var a = c.querySelector('.card__age'); return a ? Math.round(a.getBoundingClientRect().top - c.getBoundingClientRect().top) : null }),
          heights: cards.map(function(c){ return Math.round(c.getBoundingClientRect().height) })
        }
      })""")
    bad = 0
    for r in rows:
        ages = [a for a in r['ages'] if a is not None]
        uniq = sorted(set(ages))
        ok = len(uniq) <= 1 and len(set(r['heights'])) <= 1
        bad += 0 if ok else 1
        print(f"{'OK ' if ok else 'СТУПЕНЬКИ'} {r['title'][:24]:24s} отступ до года: {uniq}  высоты карточек: {sorted(set(r['heights']))}")
    b.shot(d, "05-titles")
    sys.exit(1 if bad else 0)
finally:
    d.quit()
