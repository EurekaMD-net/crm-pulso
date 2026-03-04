FROM nanoclaw-agent:latest

# Switch to root for package installation (base image ends with USER node)
USER root

# Install sqlite3 CLI + native build tools for better-sqlite3
RUN apt-get update && apt-get install -y sqlite3 python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy engine shims (overrides engine originals so CRM relative imports resolve)
COPY container/agent-runner/shims/db.ts /app/engine/src/db.ts
COPY container/agent-runner/shims/logger.ts /app/engine/src/logger.ts

# Copy CRM source
COPY src/ /app/crm/src/

# Copy agent runner package manifests for layer caching
COPY container/agent-runner/package.json container/agent-runner/package-lock.json* /app/crm/container/agent-runner/
WORKDIR /app/crm/container/agent-runner
RUN npm install

# Symlink so crm/src/ imports resolve during TypeScript build
# (node module resolution walks up from crm/src/ and finds crm/node_modules)
RUN ln -s /app/crm/container/agent-runner/node_modules /app/crm/node_modules

# Copy agent runner source and build
COPY container/agent-runner/ /app/crm/container/agent-runner/
RUN npm run build

# Switch back to non-root for runtime
USER node

# Override entrypoint to run CRM agent-runner
ENTRYPOINT ["node", "/app/crm/container/agent-runner/dist/crm/container/agent-runner/index.js"]
