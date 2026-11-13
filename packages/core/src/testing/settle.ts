/** Lets everything already queued (timers, promise chains) run before a test asserts. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
