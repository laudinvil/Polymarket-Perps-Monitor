FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY monitor.js ./
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
ENV NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node","monitor.js"]
