import { code, tsString } from '../code.js';
import type { ProjectBuilder } from '../project.js';
import { hasFeature } from '../spec.js';
import { IMAGES, VERSIONS } from '../versions.js';
import type { FeatureModule } from './types.js';

function observabilityTs(project: ProjectBuilder): string {
  const otel = hasFeature(project.spec, 'otel');
  const langfuse = hasFeature(project.spec, 'langfuse');
  const imports = [
    ...(langfuse ? ['createLangfuseExporter'] : []),
    ...(otel ? ['createOTLPExporter'] : []),
    'type RunObserver',
  ];
  return code`
    import { ${imports.join(', ')} } from '@cogitator-ai/core';

    ${
      otel &&
      code`
        /** \`key=value,key=value\`, the format of OTEL_EXPORTER_OTLP_HEADERS. */
        function parseHeaders(value: string | undefined): Record<string, string> {
          const headers: Record<string, string> = {};
          for (const pair of value?.split(',') ?? []) {
            const at = pair.indexOf('=');
            if (at > 0) headers[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(pair.slice(at + 1).trim());
          }
          return headers;
        }

        /**
         * Spans of every run to an OpenTelemetry collector (Jaeger, Tempo, Honeycomb,
         * Datadog) at OTEL_EXPORTER_OTLP_ENDPOINT, read the standard OTel way.
         */
        function otlp(): RunObserver | undefined {
          const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\\/+$/, '');
          const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (base && \`\${base}/v1/traces\`);
          if (!endpoint) return undefined;
          const exporter = createOTLPExporter({
            endpoint,
            serviceName: process.env.OTEL_SERVICE_NAME ?? ${tsString(project.spec.name)},
            headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
            enabled: true,
          });
          exporter.start();
          return exporter.observer();
        }
      `
    }

    ${
      langfuse &&
      code`
        /** Traces, inputs, outputs and costs of every run in Langfuse, when its keys are set. */
        async function langfuse(): Promise<RunObserver | undefined> {
          const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
          const secretKey = process.env.LANGFUSE_SECRET_KEY;
          if (!publicKey || !secretKey) return undefined;
          const exporter = createLangfuseExporter({
            publicKey,
            secretKey,
            baseUrl: process.env.LANGFUSE_BASE_URL,
            enabled: true,
          });
          await exporter.init();
          return exporter.observer();
        }
      `
    }

    /**
     * What watches every run of the project, each switched on by its environment
     * variables. src/cogitator.ts hands them to the runtime, and closing the
     * runtime sends what they buffered.
     */
    export const observers: RunObserver[] = [${[otel && 'otlp()', langfuse && 'await langfuse()'].filter(Boolean).join(', ')}].filter(
      (observer): observer is RunObserver => observer !== undefined
    );
  `;
}

/** Traces of every run, to an OpenTelemetry collector and to Langfuse. */
export const observabilityFeature: FeatureModule = {
  id: 'feature:observability',
  applies: (spec) => hasFeature(spec, 'otel') || hasFeature(spec, 'langfuse'),
  apply(project) {
    const { spec } = project;
    project.file('src/observability.ts', observabilityTs(project));

    if (hasFeature(spec, 'otel')) {
      project
        .service({
          name: 'jaeger',
          image: IMAGES.jaeger,
          ports: ['16686:16686', '4318:4318'],
        })
        .envVar({
          name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
          description:
            'OTLP endpoint for traces; Jaeger from docker compose listens here, its UI on :16686',
          example: 'http://localhost:4318',
          required: false,
          secret: false,
        })
        .envVar({
          name: 'OTEL_EXPORTER_OTLP_HEADERS',
          description:
            'Headers for the collector, as key=value,key=value (API keys of hosted collectors)',
          required: false,
          secret: true,
        })
        .envVar({
          name: 'OTEL_SERVICE_NAME',
          description: 'The service name traces carry',
          example: spec.name,
          required: false,
          secret: false,
        });
    }
    if (hasFeature(spec, 'langfuse')) {
      project
        .dependency('langfuse', VERSIONS.langfuse)
        .envVar({
          name: 'LANGFUSE_PUBLIC_KEY',
          description: 'Langfuse public key',
          required: false,
          secret: false,
        })
        .envVar({
          name: 'LANGFUSE_SECRET_KEY',
          description: 'Langfuse secret key',
          required: false,
          secret: true,
        })
        .envVar({
          name: 'LANGFUSE_BASE_URL',
          description: 'Langfuse server, cloud.langfuse.com unless you host it',
          example: 'https://cloud.langfuse.com',
          required: false,
          secret: false,
        });
    }

    const where = [
      hasFeature(spec, 'otel') &&
        'to the OTLP collector at `OTEL_EXPORTER_OTLP_ENDPOINT` (the Jaeger of `docker compose up -d jaeger` shows them at http://localhost:16686)',
      hasFeature(spec, 'langfuse') &&
        'to Langfuse when `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set',
    ].filter(Boolean);
    project.section(
      'Observability',
      code`
        \`src/observability.ts\` builds the run observers \`src/cogitator.ts\` hands to the runtime (\`CogitatorConfig.observers\`), so every run, from a script, a route, a workflow or a swarm, sends its spans ${where.join(' and ')}. Each is off until its variables are set, and \`cogitator.close()\` flushes them.
      `
    );
  },
};
