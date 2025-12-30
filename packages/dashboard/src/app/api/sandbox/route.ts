import { NextRequest, NextResponse } from 'next/server';
import { SandboxManager, NativeSandboxExecutor, DockerSandboxExecutor } from '@cogitator/sandbox';
import type { SandboxConfig, SandboxExecutionRequest } from '@cogitator/types';

let sandboxManager: SandboxManager | null = null;

async function getSandboxManager(): Promise<SandboxManager> {
  if (!sandboxManager) {
    sandboxManager = new SandboxManager({
      defaults: {
        type: 'native',
        timeout: 30000,
        resources: {
          memory: '256MB',
          cpus: 1,
        },
        network: {
          mode: 'none',
        },
      },
      pool: {
        maxSize: 5,
        idleTimeoutMs: 60000,
      },
    });
    await sandboxManager.initialize();
    console.log('[sandbox] Manager initialized');
  }
  return sandboxManager;
}

export async function GET() {
  try {
    await getSandboxManager();

    return NextResponse.json({
      status: 'ready',
      capabilities: {
        native: true,
        docker: false,
        wasm: false,
      },
    });
  } catch (error) {
    console.error('[api/sandbox] Status error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get sandbox status' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      code,
      language = 'javascript',
      sandboxType = 'native',
      timeout = 30000,
      env = {},
    } = body;

    if (!code || typeof code !== 'string') {
      return NextResponse.json({ error: 'code is required' }, { status: 400 });
    }

    const manager = await getSandboxManager();

    let command: string[];
    switch (language) {
      case 'javascript':
      case 'js':
        command = ['node', '-e', code];
        break;
      case 'typescript':
      case 'ts':
        command = ['npx', 'tsx', '-e', code];
        break;
      case 'python':
      case 'py':
        command = ['python3', '-c', code];
        break;
      case 'bash':
      case 'sh':
      case 'shell':
        command = ['bash', '-c', code];
        break;
      default:
        return NextResponse.json(
          { error: `Unsupported language: ${language}` },
          { status: 400 }
        );
    }

    const executionRequest: SandboxExecutionRequest = {
      command,
      env,
      timeout,
    };

    const sandboxConfig: SandboxConfig = {
      type: sandboxType,
      timeout,
      env,
      resources: {
        memory: '256MB',
        cpus: 1,
      },
      network: {
        mode: 'none',
      },
    };

    console.log('[sandbox] Executing code:', {
      language,
      sandboxType,
      timeout,
      codeLength: code.length,
    });

    const startTime = Date.now();
    const result = await manager.execute(executionRequest, sandboxConfig);
    const duration = Date.now() - startTime;

    if (!result.success) {
      return NextResponse.json({
        success: false,
        error: result.error,
        duration,
      });
    }

    return NextResponse.json({
      success: true,
      output: result.data?.stdout || '',
      stderr: result.data?.stderr || '',
      exitCode: result.data?.exitCode ?? 0,
      duration,
      timedOut: result.data?.timedOut ?? false,
    });
  } catch (error) {
    console.error('[api/sandbox] Execution error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sandbox execution failed' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    if (sandboxManager) {
      await sandboxManager.shutdown();
      sandboxManager = null;
      console.log('[sandbox] Manager shut down');
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[api/sandbox] Shutdown error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to shutdown sandbox' },
      { status: 500 }
    );
  }
}

