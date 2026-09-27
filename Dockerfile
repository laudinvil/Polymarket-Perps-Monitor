FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY scripts ./scripts
COPY deplexo.yaml ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "scripts/deplexo-log-server.js"]
