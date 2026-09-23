FROM node:22.22.0-bookworm-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /uvx /usr/local/bin/

ARG DSH_CLIENT_COMMIT_HASH=ec3763012486a6b5834bf6e997a84c098800679e
ENV CI=true
ENV DSH_CLIENT_COMMIT_HASH=$DSH_CLIENT_COMMIT_HASH
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates g++ git make python3 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /dsh
COPY . .
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
RUN pnpm run build
RUN platform_arch="$(node -p 'process.arch')" \
  && install -d "/dsh/native/landlock-run/packages/linux-${platform_arch}/bin" \
  && cc -O2 -std=c11 /dsh/native/landlock-run/packages/entry/src/main.c \
    -o "/dsh/native/landlock-run/packages/linux-${platform_arch}/bin/landlock-run" \
  && chmod 755 "/dsh/native/landlock-run/packages/linux-${platform_arch}/bin/landlock-run" \
  && "/dsh/native/landlock-run/packages/linux-${platform_arch}/bin/landlock-run" --probe

WORKDIR /dsh
ENTRYPOINT ["/dsh/acceptance/development-room/start-node.sh"]
EXPOSE 3080
