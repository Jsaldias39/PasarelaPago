# Una imagen por servicio. El contexto de construcción es la RAÍZ del repo:
#   docker build -f services/__NAME__/Dockerfile --build-arg HUB=docker.io -t __NAME__ .
ARG HUB=docker.io

FROM ${HUB}/library/node:22-alpine AS build
WORKDIR /repo
COPY .yarn ./.yarn
COPY .yarnrc.yml package.json yarn.lock tsconfig.base.json ./
COPY contracts/packages ./contracts/packages
# yarn.lock lista TODOS los workspaces: con `--immutable`, instalar con solo este servicio presente falla («The lockfile would have been modified»).
# Se copian todos para que el árbol coincida con el lockfile y, tras compilar, se quitan los demás: la imagen lleva solo este servicio.
# (`.dockerignore` deja fuera node_modules, dist y .git del contexto.)
COPY services ./services
RUN node .yarn/releases/yarn-4.14.1.cjs install --immutable
RUN node .yarn/releases/yarn-4.14.1.cjs workspaces foreach -R --topological-dev --from __NAME__ run build
RUN find services -mindepth 1 -maxdepth 1 ! -name __NAME__ -exec rm -rf {} +

FROM ${HUB}/library/node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
USER node
WORKDIR /repo/services/__NAME__
EXPOSE __PORT__
CMD ["node", "dist/main.js"]
