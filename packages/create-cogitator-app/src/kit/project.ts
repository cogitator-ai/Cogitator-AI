import type { ProjectSpec } from './spec.js';

/** A variable the generated project reads from its environment. */
export interface EnvVar {
  name: string;
  /** One line for `.env.example` and the env schema. */
  description: string;
  /** The value `.env.example` shows; secrets show an empty value. */
  example?: string;
  /** Whether the project refuses to start without it. */
  required: boolean;
  /** Whether it is a credential: never logged, kept out of `.env.example` values. */
  secret: boolean;
  /**
   * Whether a deployment must provide it, listed in `cogitator.yml` as a
   * `deploy.secrets` entry. Defaults to secrets the project requires.
   */
  deploy?: boolean;
}

/** A service `docker compose up` starts for local development. */
export interface ComposeService {
  name: string;
  image: string;
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  command?: string[];
  entrypoint?: string[];
  dependsOn?: Record<string, 'service_started' | 'service_healthy'>;
  healthcheck?: { test: string[]; interval: string; timeout: string; retries: number };
  restart?: 'no' | 'unless-stopped';
}

/** A section of the generated AGENTS.md, which coding agents read before they touch the project. */
export interface AgentsMdSection {
  title: string;
  body: string;
}

/** A command that takes the project to its first run, with an optional explanation. */
export interface NextStep {
  command: string;
  note?: string;
}

/** Something the registry `src/cogitator.ts` exports by name. */
export interface RegistryEntry {
  kind: 'agents' | 'workflows' | 'swarms';
  /** The key under which the registry exposes it. */
  name: string;
  /** The module it is imported from, relative to `src/`. */
  from: string;
  /** The binding the module exports. */
  binding: string;
}

/** What `cogitator.yml` tells `cogitator deploy` about the project. */
export interface DeploySettings {
  kind?: 'server' | 'worker';
  port?: number;
  healthPath?: string;
}

export interface GeneratedFile {
  path: string;
  /** Mutable until the plan is done, so a final pass can adapt every file. */
  content: string;
  /** File mode for `chmod`, used for `.env` (0600) and executable scripts. */
  mode?: number;
}

/**
 * The project as the feature modules build it up. Features add files, packages,
 * scripts, variables, services and documentation, and the emitters turn the
 * collected parts into package.json, `.env.example`, `docker-compose.yml`,
 * `cogitator.yml`, AGENTS.md and the registry once every feature has run.
 */
export class ProjectBuilder {
  readonly spec: ProjectSpec;
  readonly files = new Map<string, GeneratedFile>();
  readonly dependencies = new Map<string, string>();
  readonly devDependencies = new Map<string, string>();
  readonly scripts = new Map<string, string>();
  readonly env = new Map<string, EnvVar>();
  readonly services = new Map<string, ComposeService>();
  readonly volumes = new Set<string>();
  readonly agentsMd: AgentsMdSection[] = [];
  readonly readme: AgentsMdSection[] = [];
  readonly registry: RegistryEntry[] = [];
  readonly gitignore = new Set<string>();
  readonly nativeBuilds = new Set<string>();
  readonly nextSteps: NextStep[] = [];
  readonly warnings: string[] = [];
  readonly memoryYml: string[] = [];
  /** Top-level sections of cogitator.yml other features add, such as `sandbox`. */
  readonly ymlSections = new Map<string, string[]>();
  readonly deploy: DeploySettings = {};
  /** Tools the assistant gets: bindings `src/tools/index.ts` imports, `spread` for arrays of tools. */
  readonly tools: Array<{ binding: string; from: string; spread?: boolean }> = [];
  /** Imports and statements every entry point runs before it starts serving, such as indexing docs. */
  readonly startup: { imports: string[]; statements: string[] } = { imports: [], statements: [] };
  /** Lines of the assistant agent's instructions, one per feature that shapes its behavior. */
  readonly instructions: string[] = [];

  /** `name@version` of the package manager when it is known, such as `yarn@4.9.1`. */
  readonly packageManagerSpec?: string;

  constructor(spec: ProjectSpec, options: { packageManagerSpec?: string } = {}) {
    this.spec = spec;
    this.packageManagerSpec = options.packageManagerSpec;
  }

  file(path: string, content: string, mode?: number): this {
    if (this.files.has(path)) {
      throw new Error(`Two features generate ${path}: the feature modules overlap`);
    }
    this.files.set(path, { path, content, ...(mode !== undefined && { mode }) });
    return this;
  }

  /** Adds `name` at `version`. A package two features need must be asked for at one version. */
  dependency(name: string, version: string): this {
    return this.addPackage(this.dependencies, name, version);
  }

  devDependency(name: string, version: string): this {
    return this.addPackage(this.devDependencies, name, version);
  }

  private addPackage(target: Map<string, string>, name: string, version: string): this {
    const existing = target.get(name);
    if (existing !== undefined && existing !== version) {
      throw new Error(`${name} is requested at both ${existing} and ${version}`);
    }
    target.set(name, version);
    return this;
  }

  script(name: string, command: string): this {
    this.scripts.set(name, command);
    return this;
  }

  envVar(variable: EnvVar): this {
    const existing = this.env.get(variable.name);
    this.env.set(
      variable.name,
      existing ? { ...existing, required: existing.required || variable.required } : variable
    );
    return this;
  }

  service(service: ComposeService, volume?: string): this {
    this.services.set(service.name, service);
    if (volume) this.volumes.add(volume);
    return this;
  }

  section(title: string, body: string): this {
    this.agentsMd.push({ title, body });
    return this;
  }

  readmeSection(title: string, body: string): this {
    this.readme.push({ title, body });
    return this;
  }

  register(entry: RegistryEntry): this {
    if (this.registry.some((e) => e.kind === entry.kind && e.name === entry.name)) {
      throw new Error(`The registry already has ${entry.kind}.${entry.name}`);
    }
    this.registry.push(entry);
    return this;
  }

  tool(binding: string, from: string): this {
    this.tools.push({ binding, from });
    return this;
  }

  /** Gives the assistant every tool of an exported array. */
  toolSet(binding: string, from: string): this {
    this.tools.push({ binding, from, spread: true });
    return this;
  }

  ignore(...patterns: string[]): this {
    for (const pattern of patterns) this.gitignore.add(pattern);
    return this;
  }

  /** Packages with install scripts the package managers have to be allowed to run. */
  allowBuild(...packages: string[]): this {
    for (const name of packages) this.nativeBuilds.add(name);
    return this;
  }

  step(step: NextStep): this {
    this.nextSteps.push(step);
    return this;
  }

  warn(message: string): this {
    this.warnings.push(message);
    return this;
  }

  yml(section: string, lines: string[]): this {
    this.ymlSections.set(section, lines);
    return this;
  }

  onStartup(importLine: string, statement: string): this {
    if (!this.startup.imports.includes(importLine)) this.startup.imports.push(importLine);
    this.startup.statements.push(statement);
    return this;
  }

  instruct(line: string): this {
    this.instructions.push(line);
    return this;
  }
}
