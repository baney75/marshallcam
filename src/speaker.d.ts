declare module 'speaker' {
  export default class Speaker {
    constructor(opts: { channels: number; bitDepth: number; sampleRate: number })
    on(event: string, listener: (...args: unknown[]) => void): this
    close(flush?: boolean): void
  }
}
