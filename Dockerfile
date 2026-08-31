FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine

WORKDIR /app

RUN addgroup -S agenwpp && adduser -S agenwpp -G agenwpp

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY proto ./proto
COPY src ./src

RUN chown -R agenwpp:agenwpp /app

USER agenwpp

EXPOSE 50051

CMD ["node", "src/index.js"]
