FROM nanoclaw-agent:latest

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

# Copy agent runner source and build
COPY container/agent-runner/ /app/crm/container/agent-runner/
RUN npm run build

# Copy MCP servers (retained for backward compatibility)
COPY mcp/package.json mcp/package-lock.json* /app/crm-mcp/
RUN cd /app/crm-mcp && npm install
COPY mcp/ /app/crm-mcp/
RUN cd /app/crm-mcp && npm run build

# Override entrypoint to run CRM agent-runner
ENTRYPOINT ["node", "/app/crm/container/agent-runner/dist/crm/container/agent-runner/index.js"]
