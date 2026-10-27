# Una imagen por servicio. El contexto de construcción es la RAÍZ del repo:
#   docker build -f services/pay-settlement/Dockerfile --build-arg HUB=docker.io -t pay-settlement .
ARG HUB=docker.io

FROM ${HUB}/library/node:22-alpine AS build
WORKDIR /repo
COPY .yarn ./.yarn
COPY .yarnrc.yml package.json yarn.lock tsconfig.base.json ./
COPY contracts/packages ./contracts/packages
COPY services/pay-settlement ./services/pay-settlement
RUN node .yarn/releases/yarn-4.14.1.cjs install --immutable
RUN node .yarn/releases/yarn-4.14.1.cjs workspaces foreach -A --topological-dev --from pay-settlement run build

FROM ${HUB}/library/node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
USER node
WORKDIR /repo/services/pay-settlement
EXPOSE 3106
CMD ["node", "dist/main.js"]
