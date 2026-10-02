# Cogitator Makefile
# Usage: make <target>

.PHONY: help setup up down logs ps build dev test clean reset pull-models

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
	docker-compose up -d postgres redis ollama
	@echo ""
	@echo "Services started. Run 'make ps' to check status."

down:
	docker-compose down
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
	docker-compose exec ollama ollama pull nomic-embed-text-v2-moe || \
		docker-compose exec ollama ollama pull nomic-embed-text
	@echo ""
	@echo "Pulling default LLM..."
	docker-compose exec ollama ollama pull llama3.2:3b
	@echo ""
	@echo "Done! Available models:"
	@docker-compose exec ollama ollama list

models:
	docker-compose exec ollama ollama list

# ============================================================================
# Services
# ============================================================================

ps:
	docker-compose ps

logs:
	docker-compose logs -f

logs-ollama:
	docker-compose logs -f ollama

logs-pg:
	docker-compose logs -f postgres

# ============================================================================
# Database
# ============================================================================

db-shell:
	docker-compose exec postgres psql -U cogitator -d cogitator

db-reset:
	@echo "⚠️  WARNING: This will delete all data!"
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ]
	docker-compose down -v
	docker-compose up -d postgres
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
	docker-compose down -v --remove-orphans
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

