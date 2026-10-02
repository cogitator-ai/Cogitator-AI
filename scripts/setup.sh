#!/bin/bash

# Cogitator Setup Script
# Initializes all services for development

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🧠 Cogitator Setup"
echo "=================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check requirements
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}❌ $1 is required but not installed.${NC}"
        exit 1
    else
        echo -e "${GREEN}✓${NC} $1"
    fi
}

echo "Checking requirements..."
check_command docker
check_command docker-compose
check_command node
check_command pnpm

echo ""
echo -e "${BLUE}Starting Docker services...${NC}"

cd "$PROJECT_ROOT"

# Start services
docker-compose up -d postgres redis ollama

echo ""
echo -e "${YELLOW}⏳ Waiting for services to be healthy...${NC}"

# Wait for PostgreSQL
echo -n "PostgreSQL: "
until docker-compose exec -T postgres pg_isready -U cogitator -d cogitator > /dev/null 2>&1; do
    echo -n "."
    sleep 1
done
echo -e " ${GREEN}Ready${NC}"

# Wait for Redis
echo -n "Redis: "
until docker-compose exec -T redis redis-cli ping > /dev/null 2>&1; do
    echo -n "."
    sleep 1
done
echo -e " ${GREEN}Ready${NC}"

# Wait for Ollama
echo -n "Ollama: "
until curl -s http://localhost:11434/api/tags > /dev/null 2>&1; do
    echo -n "."
    sleep 1
done
echo -e " ${GREEN}Ready${NC}"

echo ""
echo -e "${BLUE}Pulling embedding model...${NC}"
echo "This may take a few minutes on first run."

# Pull embedding model
docker-compose exec -T ollama ollama pull nomic-embed-text-v2-moe || {
    echo -e "${YELLOW}⚠ Could not pull nomic-embed-text-v2-moe, trying nomic-embed-text...${NC}"
    docker-compose exec -T ollama ollama pull nomic-embed-text
}

# Pull default LLM
echo ""
echo -e "${BLUE}Pulling default LLM (llama3.2:3b)...${NC}"
docker-compose exec -T ollama ollama pull llama3.2:3b

echo ""
echo -e "${BLUE}Installing Node.js dependencies...${NC}"
pnpm install

echo ""
echo -e "${BLUE}Building packages...${NC}"
pnpm build

echo ""
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""
echo "Services running:"
echo "  • PostgreSQL: localhost:5432"
echo "  • Redis:      localhost:6379"
echo "  • Ollama:     localhost:11434"
echo ""
echo "Available models:"
docker-compose exec -T ollama ollama list
echo ""
echo -e "${YELLOW}To start the docs site:${NC}"
echo "  cd packages/dashboard && pnpm dev"
echo ""
echo -e "${YELLOW}To stop services:${NC}"
echo "  docker-compose down"
echo ""

