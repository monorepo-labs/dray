# The relay, as Railway builds it. Build context is the repo root, since the
# relay shares its wire crate with dray-serve:
#
#   docker build -f apps/relay/Dockerfile -t dray-relay .
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY crates/dray-relay crates/dray-relay
COPY apps/relay apps/relay
RUN cd apps/relay && cargo build --release --locked

FROM debian:bookworm-slim
# Roots for Let's Encrypt's and Cloudflare's APIs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/apps/relay/target/release/dray-relay /usr/local/bin/dray-relay
# PORT is the HTTP door (bridges, /healthz), which Railway sets itself;
# VISITOR_PORT is what the TCP proxy points at.
ENV PORT=8080 VISITOR_PORT=7443
EXPOSE 8080 7443
USER nobody
CMD ["dray-relay"]
