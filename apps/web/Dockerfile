FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@12.5.1
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @pfm/web... --filter @pfm/contracts...

FROM deps AS build
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm --filter @pfm/contracts build && pnpm --filter @pfm/web build

FROM nginx:1.29-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
