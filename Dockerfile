FROM node:22-bookworm
WORKDIR /app

COPY package.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --omit=dev

COPY monitor.js ./

ENV PORT=3000
ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp/.config
ENV XDG_CACHE_HOME=/tmp/.cache

EXPOSE 3000

CMD ["sh","-c","while true; do echo '=== MONITOR PROCESS START ==='; node monitor.js; code=$?; echo \"=== MONITOR EXIT CODE: $code ===\"; sleep 5; done"]
