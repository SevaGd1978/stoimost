FROM node:20-alpine

WORKDIR /app

# Копируем конфигурационные файлы и зависимости
COPY package.json ./
COPY tender-spy/package.json tender-spy/package-lock.json ./tender-spy/

# Устанавливаем зависимости
RUN npm run postinstall

# Копируем исходный код
COPY . .

# Создаем директорию для постоянного хранилища Amvera
RUN mkdir -p /data

# Порт по умолчанию для Amvera
ENV PORT=3000
ENV NODE_ENV=production
ENV TENDER_SPY_DATA=/data/db.json
ENV NODE_EXTRA_CA_CERTS=/app/tender-spy/certs/russian-trusted-ca-bundle.pem

EXPOSE 3000

CMD ["node", "tender-spy/server.js"]
