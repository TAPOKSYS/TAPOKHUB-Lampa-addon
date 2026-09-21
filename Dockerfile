# TapokHub в одном контейнере: сервер на Python (без nginx) сам отдаёт плагин для Lampa, картинки и API.
#
#   docker build -t tapokhub .
#   docker run -d --name tapokhub -p 8080:8080 -v tapokhub-data:/data tapokhub
#
# Адрес сервера подставляется в плагин при выдаче: из TAPOK_PUBLIC_URL или из адреса, по которому к серверу обратились.
# Данные (база, кеш картинок, токен доступа) лежат в /data: подключите к нему том.

# ---- сборка плагина (нужен только Python); вместо адреса сервера в плагине метка, её подменит сервер
FROM python:3.11-slim AS plugin
WORKDIR /src
COPY VERSION ./VERSION
COPY plugin ./plugin
RUN python plugin/build.py --auto-proxy --host http://tapokhub.placeholder --out dist/tapokhub.js \
 && grep -q "tapokhub.placeholder" dist/tapokhub.js && ! grep -Eq "@@[A-Z_]+@@" dist/tapokhub.js

# ---- сервер
FROM python:3.11-slim
LABEL org.opencontainers.image.title="TapokHub" \
      org.opencontainers.image.description="TapokHub server and plugin for Lampa: franchise collections, library, TMDB cache" \
      org.opencontainers.image.source="https://github.com/TAPOKSYS/TAPOKHUB-Lampa-addon" \
      org.opencontainers.image.licenses="NOASSERTION"

RUN groupadd --system --gid 10001 tapokhub \
 && useradd --system --uid 10001 --gid tapokhub --no-create-home --shell /usr/sbin/nologin tapokhub \
 && mkdir /data && chown tapokhub:tapokhub /data

COPY server/tapokhub /app/tapokhub
COPY VERSION /app/tapokhub/VERSION
COPY --from=plugin /src/dist/tapokhub.js /app/web/tapokhub.js
COPY plugin/assets /app/web/tapokhub-assets

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TAPOK_DATA=/data \
    TAPOK_TOKEN_FILE=/data/token \
    TAPOK_AUTO_TOKEN=1 \
    TAPOK_LISTEN=0.0.0.0:8080 \
    TAPOK_WEB_DIR=/app/web \
    TAPOK_REGISTRATION=closed

VOLUME ["/data"]
EXPOSE 8080
USER tapokhub

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"]

ENTRYPOINT ["python", "-m", "tapokhub"]
CMD ["serve"]
