# Una imagen por servicio. El contexto de construcción es la RAÍZ del repo:
#   docker build -f services/pay-payments/Dockerfile --build-arg HUB=docker.io -t pay-payments .
ARG HUB=docker.io

# Base glibc (no alpine): el puente nativo de Temporal (@temporalio/core-bridge) solo se distribuye para glibc; en alpine el proceso muere con
# «Error loading shared library ld-linux-x86-64.so.2» (hallado al construir la imagen, tanda 3c).
FROM ${HUB}/library/node:22-bookworm-slim AS build
WORKDIR /repo
COPY .yarn ./.yarn
COPY .yarnrc.yml package.json yarn.lock tsconfig.base.json ./
COPY contracts/packages ./contracts/packages
# yarn.lock lista TODOS los workspaces: con `--immutable`, instalar con solo este servicio presente falla («The lockfile would have been modified»).
# Se copian todos para que el árbol coincida con el lockfile y, tras compilar, se quitan los demás: la imagen lleva solo este servicio.
COPY services ./services
RUN node .yarn/releases/yarn-4.14.1.cjs install --immutable
RUN node .yarn/releases/yarn-4.14.1.cjs workspaces foreach -R --topological-dev --from pay-payments run build
RUN find services -mindepth 1 -maxdepth 1 ! -name pay-payments -exec rm -rf {} +

FROM ${HUB}/library/node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
USER node
WORKDIR /repo/services/pay-payments
EXPOSE 3102
CMD ["node", "dist/main.js"]
