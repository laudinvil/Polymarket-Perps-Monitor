FROM node:22-bookworm
WORKDIR /app

COPY package.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends firefox-esr \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --omit=dev

COPY monitor.js ./

ENV PORT=3000
ENV HOME=/tmp

EXPOSE 3000

CMD ["sh","-c","while true; do echo '=== MONITOR PROCESS START ==='; node monitor.js; code=$?; echo "=== MONITOR EXIT CODE: $code ==="; sleep 5; done"]
