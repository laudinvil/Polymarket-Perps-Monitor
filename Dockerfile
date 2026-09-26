FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install
ENV NODE_ENV=production
CMD ["node","scripts/deplexo-start.js"]
