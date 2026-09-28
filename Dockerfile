FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY monitor.js ./
RUN mkdir -p /data
VOLUME ["/data"]
ENV NODE_ENV=production
CMD ["node","monitor.js"]
