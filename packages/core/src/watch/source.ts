/** A file-system change event. */
export interface WatchEvent {
  /** The affected file's absolute path. */
  readonly path: string;
}

/** A file-system event source; the chokidar adapter implements it, tests inject manual emitters. */
export interface WatchSource {
  /**
   * Start watching; resolves to a closer that stops the source.
   * @param onChange Called with each file change event.
   * @returns A promise resolving to a function that stops the source.
   */
  start(onChange: (evt: WatchEvent) => void): Promise<() => Promise<void>>;
}
