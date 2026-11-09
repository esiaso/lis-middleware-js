# Demo and testing image only (demo/README.md). Production installs from the
# offline bundle with no Docker (11, 13); this image is never shipped.
# The full Debian image already has openssl (for the demo HMIS certificate)
# and the build tools the serial-port module falls back to.
ARG BASE=node:22-bookworm
FROM ${BASE}
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.test.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund
RUN npm run generate && npm run build
COPY demo ./demo
ENV NODE_ENV=production
