# Multi-stage build for the openterms-trace API.
#
# Stage 1 (build): install workspace deps, build @openterms/sdk first, then
# build apps/api which imports the SDK's compiled output.
#
# Stage 2 (runtime): copy only the compiled output and pruned production
# dependencies. The runtime image excludes the Python SDK packages, the
# adapter packages, the test suites, and TypeScript sources.

# -------- Stage 1: build --------
FROM node:20-bookworm-slim AS build

WORKDIR /repo

# Copy manifests first so the install layer can be cached when sources
# change but dependencies do not.
COPY package.json package-lock.json ./
COPY packages/openterms-ts/package.json packages/openterms-ts/
COPY apps/api/package.json apps/api/

# `npm ci --workspaces` installs every workspace listed in the root
# package.json. The Python packages are intentionally not part of the
# workspaces array, so they are not fetched here.
RUN npm ci --workspaces --include-workspace-root

# Copy source for the two workspaces we actually build into the image.
COPY packages/openterms-ts/ packages/openterms-ts/
COPY apps/api/ apps/api/

# Build order matters: @openterms/sdk first, then apps/api which imports
# from the SDK's dist/.
RUN npm run build --workspace @openterms/sdk \
 && npm run build --workspace @openterms/api

# tsc does not copy non-TS files into dist/. The migration runner looks for
# SQL files next to dist/db/, so stage them there explicitly.
RUN cp -R apps/api/src/db/migrations apps/api/dist/db/migrations

# Prune devDependencies so the runtime stage gets a slim node_modules tree.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# -------- Stage 2: runtime --------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /repo

# Bring in only what the running service needs: the API's compiled output,
# the SDK's compiled output (transitively imported via node_modules
# symlinks), and the pruned node_modules tree.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/packages/openterms-ts/dist ./packages/openterms-ts/dist
COPY --from=build /repo/packages/openterms-ts/package.json ./packages/openterms-ts/package.json

USER node
EXPOSE 8080

CMD ["node", "apps/api/dist/server.js"]
