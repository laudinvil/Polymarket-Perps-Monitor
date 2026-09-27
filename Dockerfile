FROM node:22-bookworm
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npx playwright install --with-deps chromium
COPY monitor.js ./
CMD ["node","monitor.js"]
