FROM node:20-alpine
ARG BUILD_SHA=unknown
WORKDIR /app
COPY package.json ./
RUN apk add --no-cache git \
  && npm install --omit=dev \
  && npm cache clean --force \
  && apk del git
COPY . .
ENV NODE_ENV=production MONITOR_BUILD_SHA=$BUILD_SHA MONITOR_HEALTH_PORT=8080 AGGR_BRIDGE_PORT=9090 AGGR_URL=http://127.0.0.1:9090/liquidations
EXPOSE 8080
CMD ["node","supervisor.js"]
