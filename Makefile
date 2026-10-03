# Cogitator Makefile
# Usage: make <target>

.PHONY: help setup up down logs ps build dev test clean reset pull-models

# Docker Compose v2 plugin when available, the standalone v1 binary otherwise
ifndef COMPOSE
COMPOSE := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo docker-compose)
endif

# Default target
help:
	@echo "🧠 Cogitator - AI Agent Runtime"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@echo "Setup & Development:"
	@echo "  setup       - Full setup: start services, pull models, install deps"
	@echo "  up          - Start all Docker services"
	@echo "  down        - Stop all Docker services"
	@echo "  dev         - Start the docs site in development mode"
	@echo "  build       - Build all packages"
	@echo ""
	@echo "Models:"
	@echo "  pull-models - Pull default Ollama models"
	@echo "  models      - List available Ollama models"
	@echo ""
	@echo "Services:"
	@echo "  ps          - Show running services"
	@echo "  logs        - Show service logs"
	@echo "  logs-ollama - Show Ollama logs"
	@echo "  logs-pg     - Show PostgreSQL logs"
	@echo ""
	@echo "Database:"
	@echo "  db-shell    - Open PostgreSQL shell"
	@echo "  db-reset    - Reset database (WARNING: deletes all data)"
	@echo ""
	@echo "Maintenance:"
	@echo "  clean       - Remove build artifacts"
	@echo "  reset       - Full reset: remove containers, volumes, node_modules"
	@echo ""

# ============================================================================
# Setup & Development
# ============================================================================

setup:
	@chmod +x scripts/setup.sh
	@./scripts/setup.sh

up:
	$(COMPOSE) up -d postgres redis ollama
	@echo ""
	@echo "Services started. Run 'make ps' to check status."

down:
	$(COMPOSE) down
	@echo "Services stopped."

dev: up
	@echo "Starting docs site..."
	cd packages/dashboard && pnpm dev

build:
	pnpm build

test:
	pnpm test

# ============================================================================
# Models
# ============================================================================

pull-models:
	@echo "Pulling embedding model..."
	$(COMPOSE) exec ollama ollama pull nomic-embed-text-v2-moe || \
		$(COMPOSE) exec ollama ollama pull nomic-embed-text
	@echo ""
	@echo "Pulling default LLM..."
	$(COMPOSE) exec ollama ollama pull llama3.2:3b
	@echo ""
	@echo "Done! Available models:"
	@$(COMPOSE) exec ollama ollama list

models:
	$(COMPOSE) exec ollama ollama list

# ============================================================================
# Services
# ============================================================================

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f

logs-ollama:
	$(COMPOSE) logs -f ollama

logs-pg:
	$(COMPOSE) logs -f postgres

# ============================================================================
# Database
# ============================================================================

db-shell:
	$(COMPOSE) exec postgres psql -U cogitator -d cogitator

db-reset:
	@echo "⚠️  WARNING: This will delete all data!"
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ]
	$(COMPOSE) down -v
	$(COMPOSE) up -d postgres
	@echo "Waiting for PostgreSQL..."
	@sleep 5
	@echo "Database reset complete."

# ============================================================================
# Maintenance
# ============================================================================

clean:
	rm -rf packages/*/dist
	rm -rf packages/*/.turbo
	rm -rf .turbo

reset: clean
	@echo "⚠️  WARNING: This will remove all containers, volumes, and node_modules!"
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ]
	$(COMPOSE) down -v --remove-orphans
	rm -rf node_modules
	rm -rf packages/*/node_modules
	@echo "Full reset complete. Run 'make setup' to start fresh."

# ============================================================================
# Quick commands
# ============================================================================

# Aliases
start: up
stop: down
restart: down up

