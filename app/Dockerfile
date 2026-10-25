# syntax=docker/dockerfile:1

# Comments are provided throughout this file to help you get started.
# If you need more help, visit the Dockerfile reference guide at
# https://docs.docker.com/engine/reference/builder/

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine

# Use production node environment by default.
ENV NODE_ENV production


WORKDIR /usr/src/app

# Download dependencies as a separate step to take advantage of Docker's caching.
# Lifecycle scripts are disabled so installed packages cannot run arbitrary code during the build.
# nodemon is a pinned devDependency, so it is installed from the lockfile here.
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    --mount=type=bind,source=.npmrc,target=.npmrc \
    --mount=type=cache,target=/root/.npm \
    npm ci --include=dev --ignore-scripts

# Copy only the application files explicitly so stray local files (env files, keys, tests) never enter the image.
COPY package.json package-lock.json .npmrc server.js facilityUtils.js permissions.js ./
COPY middleware ./middleware
COPY models ./models
COPY routes ./routes
COPY scripts ./scripts
COPY seed ./seed
COPY views ./views

# Run the application as a non-root user.
RUN  chown -R node /usr/src/app
USER node

# Expose the port that the application listens on.
EXPOSE 3000

# Run the application in dev mode to use with Compose watch feature
CMD ["npm", "run", "dev"]
