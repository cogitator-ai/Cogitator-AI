import { code } from '../code.js';
import { providerInfo } from '../providers.js';
import { bareModel, hasFeature } from '../spec.js';
import { IMAGES } from '../versions.js';
import type { FeatureModule } from './types.js';

/**
 * Ollama in compose starts with an empty volume, so a one-shot `ollama-pull`
 * service downloads the models the project uses once the server is healthy.
 * Later starts find them in the volume and finish at once.
 */
export const providerFeature: FeatureModule = {
  id: 'provider',
  applies: () => true,
  apply(project) {
    const { spec } = project;
    const info = providerInfo(spec.provider);

    if (spec.provider === 'ollama') {
      const models = [bareModel(spec)];
      if (hasFeature(spec, 'rag') && info.embeddingModel) models.push(info.embeddingModel);

      project.service(
        {
          name: 'ollama',
          image: IMAGES.ollama,
          ports: ['11434:11434'],
          volumes: ['ollama_data:/root/.ollama'],
          healthcheck: {
            test: ['CMD', 'ollama', 'list'],
            interval: '5s',
            timeout: '5s',
            retries: 20,
          },
        },
        'ollama_data'
      );
      project.service({
        name: 'ollama-pull',
        image: IMAGES.ollama,
        dependsOn: { ollama: 'service_healthy' },
        environment: { OLLAMA_HOST: 'http://ollama:11434' },
        entrypoint: ['/bin/sh', '-c', models.map((model) => `ollama pull ${model}`).join(' && ')],
        restart: 'no',
      });
    }

    project.section(
      'Model',
      code`
        The default model is set in \`cogitator.yml\` (\`llm.defaultModel\`, as \`provider/model\`) and agents without a \`model\` of their own use it. ${
          info.envKey
            ? `The ${info.label} key is read from \`${info.envKey}\` in \`.env\`.`
            : 'Ollama runs locally: `OLLAMA_BASE_URL` points at it, `http://localhost:11434` by default.'
        }
      `
    );
  },
};
