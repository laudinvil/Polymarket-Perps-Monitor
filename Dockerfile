FROM node:20-alpine
ARG BUILD_SHA=unknown

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    MONITOR_BUILD_SHA=$BUILD_SHA
EXPOSE 8080

CMD ["node","monitor.js"]
