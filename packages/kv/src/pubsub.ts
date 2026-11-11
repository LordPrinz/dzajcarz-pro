/** Called with each message published to a channel. */
export type PubSubListener = (message: string) => void;

/** Stops delivery to the listener it was returned for; the other listeners on the channel keep theirs. */
export type Unsubscribe = () => Promise<void>;

/**
 * Fire-and-forget messaging between processes (ADR 9). At most once: a message published while nobody listens,
 * or while a connection is down, is gone. Nothing is stored, so it fits ADR 3's "Redis holds only state that
 * can be lost".
 */
export interface PubSub {
  /** Delivers `message` to everyone subscribed to `channel` and returns how many subscribers received it. */
  publish(channel: string, message: string): Promise<number>;
  /**
   * Never rejects for a connection that is down or still connecting: the listener stays registered and the
   * adapter subscribes again once it is back. Use `isSubscribed` to know whether messages can arrive now.
   */
  subscribe(channel: string, listener: PubSubListener): Promise<Unsubscribe>;
  /** Whether a message published to `channel` right now would reach this process's listeners. */
  isSubscribed(channel: string): boolean;
}
