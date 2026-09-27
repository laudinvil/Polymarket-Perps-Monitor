FROM node:22-bookworm
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY monitor.js ./

ENV PORT=3000
ENV HOME=/tmp

EXPOSE 3000

CMD ["node","monitor.js"]
