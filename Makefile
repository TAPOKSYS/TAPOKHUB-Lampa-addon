# TapokHub: типовые команды. `make` без цели показывает список.
SHELL := /bin/bash
.DEFAULT_GOAL := help
VERSION := $(shell cat VERSION)

.PHONY: help version test build docker clean

help:            ## показать команды
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

version:         ## версия сборки
	@echo $(VERSION)

test:            ## все тесты: плагин и сервер
	@scripts/test.sh

build:           ## собрать плагин в dist/tapokhub.js
	@python3 plugin/build.py --auto-proxy && node --check dist/tapokhub.js

docker:          ## собрать образ и проверить его на настоящем Docker
	@scripts/docker-test.sh

clean:           ## убрать сборки и кеши
	@rm -rf dist/tapokhub.test.js dist/t.js dist/site dist/site.test; find . -name __pycache__ -type d -prune -exec rm -rf {} +
