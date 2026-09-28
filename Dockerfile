FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN node -e "const fs=require('fs'); const p='/app/package.json'; const s=fs.readFileSync(p,'utf8'); JSON.parse(s); console.log('package.json OK')"
RUN npm install --omit=dev
COPY monitor.js ./
COPY bootstrap.js ./
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
ENV NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node","bootstrap.js"]
