# Contributing to Cogitator

Thank you for your interest in contributing to Cogitator! This document provides guidelines and information for contributors.

## Code of Conduct

By participating in this project, you agree to abide by our code of conduct: be respectful, inclusive, and constructive.

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 8+
- Docker (for sandbox testing)
- Ollama (for local LLM testing)

### Setup

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/YOUR_USERNAME/cogitator.git
cd cogitator
git remote add upstream https://github.com/cogitator-ai/Cogitator-AI.git

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Start development mode
pnpm dev
```

### Project Structure

```
cogitator/
├── packages/
│   ├── core/           # Core runtime and LLM backends (@cogitator-ai/core)
│   ├── cli/            # CLI tool (@cogitator-ai/cli)
│   ├── config/         # Configuration loader (@cogitator-ai/config)
│   ├── types/          # Shared types (@cogitator-ai/types)
│   ├── memory/         # Memory adapters (@cogitator-ai/memory)
│   ├── models/         # Model registry and discovery (@cogitator-ai/models)
│   ├── mcp/            # Model Context Protocol adapter (@cogitator-ai/mcp)
│   ├── openai-compat/  # OpenAI-compatible API server (@cogitator-ai/openai-compat)
│   ├── redis/          # Redis client with cluster support (@cogitator-ai/redis)
│   ├── workflows/      # Workflow engine (@cogitator-ai/workflows)
│   ├── swarms/         # Swarm coordination (@cogitator-ai/swarms)
│   ├── sandbox/        # Code execution sandbox (@cogitator-ai/sandbox)
│   ├── wasm-tools/     # WASM plugin system (@cogitator-ai/wasm-tools)
│   ├── worker/         # Background job worker (@cogitator-ai/worker)
│   └── dashboard/      # Web dashboard & API (@cogitator-ai/dashboard)
├── docs/               # Documentation
└── scripts/            # Build and utility scripts
```

## How to Contribute

### Reporting Bugs

1. Check existing issues to avoid duplicates
2. Use the bug report template
3. Include:
   - Clear description of the problem
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (OS, Node version, etc.)
   - Relevant logs or error messages

### Suggesting Features

1. Check existing issues and discussions
2. Use the feature request template
3. Describe:
   - The problem you're trying to solve
   - Your proposed solution
   - Alternatives you've considered
   - Any relevant examples

### Pull Requests

1. **Fork and branch**: Create a feature branch from `main`

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Write code**: Follow our coding standards (see below)

3. **Test**: Add tests for new functionality

   ```bash
   pnpm test
   ```

4. **Lint**: Ensure code passes linting

   ```bash
   pnpm lint
   ```

5. **Commit**: Use conventional commit messages

   ```bash
   git commit -m "feat(core): add new agent feature"
   ```

6. **Push and PR**: Push your branch and create a pull request

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types:

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvement
- `test`: Adding tests
- `chore`: Maintenance tasks

Scopes:

- `core`: @cogitator-ai/core
- `cli`: @cogitator-ai/cli
- `config`: @cogitator-ai/config
- `types`: @cogitator-ai/types
- `memory`: @cogitator-ai/memory
- `models`: @cogitator-ai/models
- `mcp`: @cogitator-ai/mcp
- `openai-compat`: @cogitator-ai/openai-compat
- `redis`: @cogitator-ai/redis
- `workflows`: @cogitator-ai/workflows
- `swarms`: @cogitator-ai/swarms
- `sandbox`: @cogitator-ai/sandbox
- `wasm-tools`: @cogitator-ai/wasm-tools
- `worker`: @cogitator-ai/worker
- `dashboard`: @cogitator-ai/dashboard

Examples:

```
feat(core): add support for streaming responses
fix(memory): resolve race condition in context builder
docs(readme): update installation instructions
```

## Coding Standards

### TypeScript

- Use TypeScript strict mode
- Prefer `interface` over `type` for object shapes
- Use explicit return types for public APIs
- Avoid `any` - use `unknown` or proper types

```typescript
// Good
interface AgentConfig {
  name: string;
  model: string;
  temperature?: number;
}

export function createAgent(config: AgentConfig): Agent {
  // ...
}

// Bad
export function createAgent(config: any) {
  // ...
}
```

### Code Style

- 2 spaces for indentation
- Single quotes for strings
- Semicolons required
- Max line length: 100 characters
- Use ESLint and Prettier (configured in repo)

```bash
# Format code
pnpm format

# Check linting
pnpm lint
```

### Testing

- Write tests for all new functionality
- Use descriptive test names
- Aim for >80% coverage on new code

```typescript
describe('Agent', () => {
  describe('run()', () => {
    it('should execute with provided input', async () => {
      const agent = new Agent({ name: 'test', model: 'mock' });
      const result = await agent.run('Hello');
      expect(result.output).toBeDefined();
    });

    it('should throw on invalid configuration', () => {
      expect(() => new Agent({ name: '' })).toThrow();
    });
  });
});
```

### Documentation

- Add JSDoc comments for public APIs
- Update relevant docs when changing functionality
- Include examples in documentation

````typescript
/**
 * Creates a new agent with the specified configuration.
 *
 * @param config - Agent configuration options
 * @returns A configured Agent instance
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   name: 'my-agent',
 *   model: 'llama3.3:latest',
 *   instructions: 'You are a helpful assistant.',
 * });
 * ```
 */
export function createAgent(config: AgentConfig): Agent {
  // ...
}
````

## Development Workflow

### Running Specific Packages

```bash
# Build a specific package
pnpm --filter @cogitator-ai/core build

# Test a specific package
pnpm --filter @cogitator-ai/core test

# Watch mode for development
pnpm --filter @cogitator-ai/core dev
```

### Adding Dependencies

```bash
# Add to a specific package
pnpm --filter @cogitator-ai/core add zod

# Add as dev dependency
pnpm --filter @cogitator-ai/core add -D vitest

# Add to root (workspace tools)
pnpm add -w -D typescript
```

### Creating a New Package

```bash
# Create package directory
mkdir -p packages/my-package/src

# Initialize package.json
cd packages/my-package
pnpm init

# Add to workspace (already configured)
```

## Priority Areas

We especially welcome contributions in these areas:

1. **LLM Backends**: Implementations for new providers (Google, Cohere, local models)
2. **Built-in Tools**: Useful tools for common tasks
3. **Memory Adapters**: Support for different storage backends
4. **Documentation**: Improvements, examples, tutorials
5. **Testing**: Increased test coverage
6. **Performance**: Optimizations and benchmarks

## Getting Help

- **Discussions**: Use GitHub Discussions for questions
- **Issues**: Report bugs and request features

## Recognition

Contributors will be recognized in:

- CONTRIBUTORS.md file
- Release notes
- Project README (for significant contributions)

## License

By contributing to Cogitator, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Cogitator! 🚀
