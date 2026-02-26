import { describe, it, expect } from 'vitest';
import { formatOpenAIError } from '../server/middleware/error-handler';

describe('formatOpenAIError', () => {
  it('formats error with all fields', () => {
    const err = formatOpenAIError(
      'invalid_request',
      'Bad request',
      'invalid_request_error',
      'model'
    );

    expect(err).toEqual({
      error: {
        message: 'Bad request',
        type: 'invalid_request_error',
        param: 'model',
        code: 'invalid_request',
      },
    });
  });

  it('uses default type when not provided', () => {
    const err = formatOpenAIError('not_found', 'Resource not found');

    expect(err.error.type).toBe('invalid_request_error');
  });

  it('omits param when not provided', () => {
    const err = formatOpenAIError('internal_error', 'Server error', 'server_error');

    expect(err.error.param).toBeUndefined();
  });
});
