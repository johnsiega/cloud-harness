FROM public.ecr.aws/lambda/microvms:al2023-minimal

ARG NODE_MAJOR=22
ARG PHP_VERSION=8.3

# git + PHP (with pdo_sqlite) + sqlite + Node + Composer + Python (pip, pytest) + Codex CLI; the last line fails the build early if a tool is missing.
RUN dnf install -y curl-minimal git tar gzip unzip which findutils procps-ng sqlite python3 python3-pip \
      php${PHP_VERSION}-cli php${PHP_VERSION}-common php${PHP_VERSION}-pdo php${PHP_VERSION}-mbstring \
      php${PHP_VERSION}-xml php${PHP_VERSION}-process \
 && curl -fsSL https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && dnf install -y nodejs \
 && curl -fsSL https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer \
 && npm install -g @openai/codex \
 && python3 -m pip install --no-cache-dir pytest \
 && dnf clean all \
 && php -m | grep -i pdo_sqlite && node -v && composer --version && codex --version && git --version \
 && python3 --version && python3 -m pytest --version && timeout --version

WORKDIR /opt/runner
COPY server.mjs run-task.sh detect-tests.mjs /opt/runner/

EXPOSE 8080
CMD ["node", "/opt/runner/server.mjs"]
