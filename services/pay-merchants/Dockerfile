# Una imagen por servicio. El contexto de construcción es la RAÍZ del repo:
#   docker build -f services/pay-merchants/Dockerfile --build-arg HUB=docker.io -t pay-merchants .
ARG HUB=docker.io

FROM ${HUB}/library/node:22-alpine AS build
WORKDIR /repo
# El lockfile es de TODO el monorepo: `install --immutable` solo es válido si ve el package.json de cada workspace (con uno solo
# yarn recorta el lockfile y lo rechaza: YN0028). `pay-merchants/Dockerfile.dockerignore` deja pasar los manifiestos de los demás
# servicios, pero no su código.
COPY . ./
RUN node .yarn/releases/yarn-4.14.1.cjs install --immutable
RUN node .yarn/releases/yarn-4.14.1.cjs workspaces foreach -R --topological-dev --from pay-merchants run build

FROM ${HUB}/library/node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
USER node
WORKDIR /repo/services/pay-merchants
EXPOSE 3107
CMD ["node", "dist/main.js"]
