# The static LAN server of offline mode 1 (F550, ADR 0033): nginx serving a site build, engine assets, offline
# packages and static tile folders with the headers the engine needs. The base image is pinned by digest.
FROM nginx:1.27.5-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN mkdir -p /srv/site /srv/packages /srv/tiles
EXPOSE 8080
