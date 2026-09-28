FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY monitor.js ./
RUN mkdir -p /data
ENV NODE_ENV=production
CMD ["node","monitor.js"]
