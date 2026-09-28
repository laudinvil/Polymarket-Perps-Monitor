FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY monitor.js ./
COPY live-monitor.js ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node","monitor.js"]
