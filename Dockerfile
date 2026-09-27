FROM node:22-bookworm
WORKDIR /app

COPY package.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --omit=dev

COPY monitor.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node","monitor.js"]
