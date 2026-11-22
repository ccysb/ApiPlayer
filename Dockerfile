FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# 应用只依赖 Node.js 内置模块与原生 fetch，无需 npm install
COPY package.json ./
COPY worker.js server.js ./
COPY lib ./lib

EXPOSE 8080
CMD ["node", "server.js"]
