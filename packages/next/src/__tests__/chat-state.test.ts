import { describe, it, expect } from 'vitest';
import { chatReducer, createInitialState } from '../client/use-chat-state.js';
import type { ChatMessage } from '../types.js';

describe('createInitialState', () => {
  it('creates default state', () => {
    const state = createInitialState();
    expect(state).toEqual({
      messages: [],
      input: '',
      isLoading: false,
      error: null,
      threadId: undefined,
      currentMessageId: null,
      currentContent: '',
      currentToolCalls: [],
    });
  });

  it('creates state with initial messages', () => {
    const msgs: ChatMessage[] = [{ id: '1', role: 'user', content: 'hi' }];
    const state = createInitialState(msgs, 'thread_1');
    expect(state.messages).toEqual(msgs);
    expect(state.threadId).toBe('thread_1');
  });
});

describe('chatReducer', () => {
  const initial = createInitialState();

  it('SET_INPUT', () => {
    const state = chatReducer(initial, { type: 'SET_INPUT', payload: 'hello' });
    expect(state.input).toBe('hello');
  });

  it('SET_THREAD_ID', () => {
    const state = chatReducer(initial, { type: 'SET_THREAD_ID', payload: 't_1' });
    expect(state.threadId).toBe('t_1');
  });

  it('START_LOADING', () => {
    const withError = { ...initial, error: new Error('old') };
    const state = chatReducer(withError, { type: 'START_LOADING' });
    expect(state.isLoading).toBe(true);
    expect(state.error).toBeNull();
  });

  it('STOP_LOADING', () => {
    const loading = { ...initial, isLoading: true };
    const state = chatReducer(loading, { type: 'STOP_LOADING' });
    expect(state.isLoading).toBe(false);
  });

  it('SET_ERROR', () => {
    const loading = { ...initial, isLoading: true };
    const err = new Error('fail');
    const state = chatReducer(loading, { type: 'SET_ERROR', payload: err });
    expect(state.error).toBe(err);
    expect(state.isLoading).toBe(false);
  });

  it('ADD_USER_MESSAGE', () => {
    const msg: ChatMessage = { id: '1', role: 'user', content: 'hi' };
    const state = chatReducer(initial, { type: 'ADD_USER_MESSAGE', payload: msg });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toBe(msg);
  });

  it('APPEND_MESSAGE', () => {
    const msg: ChatMessage = { id: '1', role: 'assistant', content: 'hello' };
    const state = chatReducer(initial, { type: 'APPEND_MESSAGE', payload: msg });
    expect(state.messages).toHaveLength(1);
  });

  it('START_ASSISTANT_MESSAGE', () => {
    const state = chatReducer(initial, {
      type: 'START_ASSISTANT_MESSAGE',
      payload: 'msg_1',
    });
    expect(state.currentMessageId).toBe('msg_1');
    expect(state.currentContent).toBe('');
    expect(state.currentToolCalls).toEqual([]);
  });

  it('APPEND_CONTENT', () => {
    const started = chatReducer(initial, {
      type: 'START_ASSISTANT_MESSAGE',
      payload: 'msg_1',
    });
    const s1 = chatReducer(started, { type: 'APPEND_CONTENT', payload: 'Hello' });
    const s2 = chatReducer(s1, { type: 'APPEND_CONTENT', payload: ' world' });
    expect(s2.currentContent).toBe('Hello world');
  });

  it('ADD_TOOL_CALL', () => {
    const tc = { id: 'tc_1', name: 'search', arguments: { q: 'test' } };
    const state = chatReducer(initial, { type: 'ADD_TOOL_CALL', payload: tc });
    expect(state.currentToolCalls).toHaveLength(1);
    expect(state.currentToolCalls[0]).toBe(tc);
  });

  it('FINISH_ASSISTANT_MESSAGE builds message and resets', () => {
    let state = chatReducer(initial, {
      type: 'START_ASSISTANT_MESSAGE',
      payload: 'msg_1',
    });
    state = chatReducer(state, { type: 'APPEND_CONTENT', payload: 'Hi there' });
    state = chatReducer(state, { type: 'FINISH_ASSISTANT_MESSAGE' });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].id).toBe('msg_1');
    expect(state.messages[0].role).toBe('assistant');
    expect(state.messages[0].content).toBe('Hi there');
    expect(state.messages[0].toolCalls).toBeUndefined();
    expect(state.currentMessageId).toBeNull();
    expect(state.currentContent).toBe('');
  });

  it('FINISH_ASSISTANT_MESSAGE with tool calls', () => {
    let state = chatReducer(initial, {
      type: 'START_ASSISTANT_MESSAGE',
      payload: 'msg_1',
    });
    const tc = { id: 'tc_1', name: 'search', arguments: {} };
    state = chatReducer(state, { type: 'ADD_TOOL_CALL', payload: tc });
    state = chatReducer(state, { type: 'FINISH_ASSISTANT_MESSAGE' });

    expect(state.messages[0].toolCalls).toEqual([tc]);
  });

  it('FINISH_ASSISTANT_MESSAGE is no-op without currentMessageId', () => {
    const state = chatReducer(initial, { type: 'FINISH_ASSISTANT_MESSAGE' });
    expect(state).toBe(initial);
  });

  it('SET_MESSAGES', () => {
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', content: 'a' },
      { id: '2', role: 'assistant', content: 'b' },
    ];
    const state = chatReducer(initial, { type: 'SET_MESSAGES', payload: msgs });
    expect(state.messages).toEqual(msgs);
  });

  it('CLEAR_MESSAGES', () => {
    const withMsgs = {
      ...initial,
      messages: [{ id: '1', role: 'user' as const, content: 'hi' }],
    };
    const state = chatReducer(withMsgs, { type: 'CLEAR_MESSAGES' });
    expect(state.messages).toEqual([]);
  });

  it('returns same state on unknown action', () => {
    const state = chatReducer(initial, { type: 'UNKNOWN' } as never);
    expect(state).toBe(initial);
  });
});
