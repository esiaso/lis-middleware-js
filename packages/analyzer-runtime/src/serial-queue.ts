/** Runs async jobs one at a time, in order. Used so a unit is never handled while the previous one is still committing. */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  get pending(): number {
    return this.#pending;
  }

  push(job: () => Promise<void>): Promise<void> {
    this.#pending++;
    const run = this.#tail.then(job).finally(() => this.#pending--);
    this.#tail = run.catch(() => {});
    return run;
  }

  idle(): Promise<void> {
    return this.#tail;
  }
}
