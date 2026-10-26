# The Ramp API, for a VPS.
#
# Runs the TypeScript directly through tsx: there is no build step to drift
# from the source, and the image is the repository as it stands.
FROM node:24-slim

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts && chown -R node:node /app

USER node
EXPOSE 8787

# The API answers /v1/health without a key, so the container is judged by the
# same endpoint a load balancer would use.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RAMP_PORT||8787)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "ramp:serve"]
