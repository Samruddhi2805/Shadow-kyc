# Production Dockerfile for Shadow-KYC Permanent Backend API
# Pairs with Midnight Proof Server (port 6300) on Midnight Preprod Testnet
FROM node:22-bookworm-slim

WORKDIR /app

# Install native toolchain required for LevelDB / Node bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install root dependencies
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy managed contract artifacts (pre-compiled, do not regenerate)
COPY contracts/managed ./contracts/managed

# Copy backend source, config, and state
COPY src ./src
COPY tsconfig.json .
COPY .midnight-state.json .

# Environment defaults for production Preprod
ENV NODE_ENV=production
ENV PORT=8080
ENV NETWORK=preprod
ENV CONTRACT_ADDRESS=1387bebdf07d4f8d5d9cc5d5f8e1e27db2a3a37e3b144daf4ec2413d5374abc0
ENV MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300

EXPOSE 8080

# Run API server via tsx
CMD ["npx", "tsx", "src/api-server.ts"]
