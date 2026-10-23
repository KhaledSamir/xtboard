FROM node:24-alpine
ENV XTBOARD_HOME=/data XTBOARD_PORT=9119
WORKDIR /app
COPY . .
RUN mkdir -p /data && chmod +x /app/xtb
EXPOSE 9119
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:9119/api/healthz || exit 1
CMD ["node","server.js"]
