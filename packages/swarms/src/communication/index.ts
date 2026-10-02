/**
 * Communication primitives for swarm coordination
 */

export { SwarmEventEmitterImpl } from './event-emitter.js';
export {
  InMemoryMessageBus,
  createMessageBus,
  isReadTrackingMessageBus,
  type ReadTrackingMessageBus,
  type MessageListener,
} from './message-bus.js';
export {
  InMemoryBlackboard,
  createBlackboard,
  isObservableBlackboard,
  type ObservableBlackboard,
  type BlackboardWrite,
  type BlackboardWriteListener,
  type BlackboardSectionHandler,
} from './blackboard.js';

export { RedisMessageBus, type RedisMessageBusOptions } from './redis-message-bus.js';
export { RedisBlackboard, type RedisBlackboardOptions } from './redis-blackboard.js';
export { RedisSwarmEventEmitter, type RedisEventEmitterOptions } from './redis-event-emitter.js';
