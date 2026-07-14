FROM mcr.microsoft.com/playwright:v1.61.1-jammy

RUN npm install -g pnpm@10

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./

COPY lib/api-zod/package.json          lib/api-zod/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/db/package.json               lib/db/
COPY lib/api-spec/package.json         lib/api-spec/
COPY scripts/package.json              scripts/
COPY artifacts/api-server/package.json artifacts/api-server/

RUN pnpm install --frozen-lockfile

COPY lib/       lib/
COPY scripts/   scripts/
COPY artifacts/api-server/ artifacts/api-server/

RUN pnpm --filter @workspace/api-server   run build

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 8080

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
