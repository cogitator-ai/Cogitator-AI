'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';

interface Model {
  id: string;
  name: string;
  provider: string;
  pricing: {
    input: number;
    output: number;
  };
}

export function useModels() {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function fetchModels() {
      try {
        const data = await api.getModels();
        if (mounted) {
          setModels(data);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to fetch models');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    void fetchModels();

    return () => {
      mounted = false;
    };
  }, []);

  const getModel = (id: string) => models.find((m) => m.id === id);

  const getPrice = (id: string) => {
    const model = getModel(id);
    return model?.pricing ?? null;
  };

  const getModelsByProvider = (provider: string) => models.filter((m) => m.provider === provider);

  return {
    models,
    loading,
    error,
    getModel,
    getPrice,
    getModelsByProvider,
  };
}
